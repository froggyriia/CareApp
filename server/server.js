// CareApp payments test backend
// Connect (caregivers get paid) + Payments (one-time booking) +
// Billing (weekly / monthly / yearly care plans) + Invoicing (bills for insurance)
// The mobile app never sees the secret key; it only talks to this server.
const express = require('express');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const {
  STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET,
  PLATFORM_FEE_PERCENT = '10',
  CURRENCY = 'eur',
  CONNECT_COUNTRY = 'MT',
  BASE_URL = 'http://localhost:4242',
} = process.env;

if (!STRIPE_SECRET_KEY?.startsWith('sk_test_') || !STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_')) {
  console.error('Set STRIPE_SECRET_KEY (sk_test_...) and STRIPE_PUBLISHABLE_KEY (pk_test_...) in .env');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const FEE = Number(PLATFORM_FEE_PERCENT);
const toCents = (eur) => Math.round(Number(eur) * 100);
const app = express();

// --- tiny JSON "database" so caregivers survive restarts ---------------------
const DB = path.join(__dirname, 'data.json');
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { caregivers: [] });
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const requireCaregiver = (id) => {
  if (!load().caregivers.some((c) => c.id === id)) throw new Error('Unknown caregiver');
};

// --- webhook (raw body, so it must come before express.json) ----------------
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  const o = event.data.object;
  switch (event.type) {
    // With direct charges these events happen on caregiver accounts:
    // forward them with `stripe listen --forward-connect-to localhost:4242/webhook`
    case 'payment_intent.succeeded':     console.log('Booking paid:', o.id, o.amount / 100); break;
    case 'invoice.paid':                 console.log('Invoice paid:', o.id); break;
    case 'invoice.payment_failed':       console.log('Invoice payment failed:', o.id); break;
    case 'customer.subscription.created':console.log('Care plan started:', o.id, o.status); break;
    case 'customer.subscription.deleted':console.log('Care plan cancelled:', o.id); break;
    case 'account.updated':              console.log('Caregiver', o.id, 'charges_enabled =', o.charges_enabled); break;
    default:                             console.log('Event:', event.type);
  }
  res.json({ received: true });
});

app.use(express.json());

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e.message);
    res.status(400).json({ error: e.message });
  });

app.get('/config', (req, res) => res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY, feePercent: FEE, currency: CURRENCY }));

// Page Stripe onboarding returns to (the user then switches back to the app)
app.get('/onboarding-done', (req, res) =>
  res.send('<h2 style="font-family:sans-serif">Onboarding finished. Go back to CareApp and tap Refresh.</h2>'));

// --- Funds flow: DIRECT CHARGES -------------------------------------------------
// Matches the sandbox's platform profile: "Sellers collect payments directly",
// negative-balance liability = Stripe (Managed Risk).
// Every payment / subscription / invoice is created ON the caregiver's account
// (Stripe-Account header), and the platform takes an application fee.
const onAccount = (caregiverId) => ({ stripeAccount: caregiverId });

// Customer + ephemeral key on the caregiver's account, so PaymentSheet can save cards
async function customerWithKey(caregiverId, name, email) {
  const customer = await stripe.customers.create({ name, email }, onAccount(caregiverId));
  const key = await stripe.ephemeralKeys.create(
    { customer: customer.id },
    { apiVersion: '2020-08-27', ...onAccount(caregiverId) },
  );
  return { customer: customer.id, ephemeralKey: key.secret };
}

// --- 1. CONNECT: caregiver onboarding (Accounts v2) ---------------------------
app.post('/api/caregivers', wrap(async (req, res) => {
  const { name, email } = req.body;
  // Caregiver = merchant (accepts card payments). Stripe collects its fees from the
  // caregiver and manages risk/losses; caregiver gets the full Stripe Dashboard.
  const account = await stripe.v2.core.accounts.create({
    display_name: name,
    contact_email: email,
    dashboard: 'full',
    identity: { country: CONNECT_COUNTRY, entity_type: 'individual' },
    defaults: {
      currency: CURRENCY,
      responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
    },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
    },
  });
  const db = load();
  db.caregivers.push({ id: account.id, name, email });
  save(db);
  res.json({ id: account.id });
}));

app.post('/api/caregivers/:id/onboard', wrap(async (req, res) => {
  requireCaregiver(req.params.id);
  const link = await stripe.v2.core.accountLinks.create({
    account: req.params.id,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        refresh_url: `${BASE_URL}/onboarding-done`,
        return_url: `${BASE_URL}/onboarding-done`,
      },
    },
  });
  res.json({ url: link.url });
}));

app.get('/api/caregivers', wrap(async (req, res) => {
  const list = await Promise.all(load().caregivers.map(async (c) => {
    const a = await stripe.v2.core.accounts.retrieve(c.id, { include: ['configuration.merchant'] });
    const status = a.configuration?.merchant?.capabilities?.card_payments?.status;
    // "ready" = the caregiver can accept card payments
    return { ...c, transfersStatus: status, chargesEnabled: status === 'active' };
  }));
  res.json(list);
}));

// --- 2. PAYMENTS: one-time booking (direct charge + platform fee) ------------
app.post('/api/bookings', wrap(async (req, res) => {
  const { caregiverId, service, amount, clientName, clientEmail } = req.body;
  requireCaregiver(caregiverId);
  const cents = toCents(amount);
  const { customer, ephemeralKey } = await customerWithKey(caregiverId, clientName, clientEmail);
  const pi = await stripe.paymentIntents.create({
    amount: cents,
    currency: CURRENCY,
    customer,
    description: service,
    automatic_payment_methods: { enabled: true },
    application_fee_amount: Math.round((cents * FEE) / 100),
    metadata: { service },
  }, onAccount(caregiverId));
  res.json({ clientSecret: pi.client_secret, customer, ephemeralKey, stripeAccountId: caregiverId });
}));

// --- 3. BILLING: recurring care plan (week / month / year) --------------------
app.post('/api/plans', wrap(async (req, res) => {
  const { caregiverId, service, amount, interval, clientName, clientEmail } = req.body;
  requireCaregiver(caregiverId);
  if (!['week', 'month', 'year'].includes(interval)) throw new Error('interval must be week, month or year');
  const { customer, ephemeralKey } = await customerWithKey(caregiverId, clientName, clientEmail);
  const product = await stripe.products.create({ name: `${service} (${interval}ly plan)` }, onAccount(caregiverId));
  const sub = await stripe.subscriptions.create({
    customer,
    items: [{ price_data: { currency: CURRENCY, product: product.id, unit_amount: toCents(amount), recurring: { interval } } }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    application_fee_percent: FEE,
    metadata: { service },
    expand: ['latest_invoice.confirmation_secret'],
  }, onAccount(caregiverId));
  res.json({
    subscriptionId: sub.id,
    clientSecret: sub.latest_invoice.confirmation_secret.client_secret,
    customer,
    ephemeralKey,
    stripeAccountId: caregiverId,
  });
}));

// --- 4. INVOICING: bill a client (e.g. a bill to send to insurance) ----------
app.post('/api/invoices', wrap(async (req, res) => {
  const { caregiverId, clientName, clientEmail, description, amount } = req.body;
  requireCaregiver(caregiverId);
  const cents = toCents(amount);
  const opts = onAccount(caregiverId);
  const customer = await stripe.customers.create({ name: clientName, email: clientEmail }, opts);
  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: 7,
    application_fee_amount: Math.round((cents * FEE) / 100),
  }, opts);
  await stripe.invoiceItems.create({ customer: customer.id, invoice: invoice.id, amount: cents, currency: CURRENCY, description }, opts);
  const done = await stripe.invoices.finalizeInvoice(invoice.id, {}, opts);
  res.json({ id: done.id, hostedInvoiceUrl: done.hosted_invoice_url, invoicePdf: done.invoice_pdf });
}));

app.listen(4242, '0.0.0.0', () => console.log(`CareApp payments server on ${BASE_URL}`));
