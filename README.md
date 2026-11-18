# CareApp — Stripe payments test

A payments-only slice of CareApp (caregiver search), built to test the Stripe integration before it goes into the main app.

| Folder | What it is |
|---|---|
| `server/` | Node + Express backend. Holds the Stripe secret key and talks to Stripe. |
| `app/` | React Native (Expo) app with one test screen, using the native Stripe PaymentSheet. |

The mobile app never sees the secret key. It only calls the server.

## What it tests

| # | Stripe product | In the app |
|---|---|---|
| 1 | **Connect** (Accounts v2) | Create a caregiver as a connected account and onboard them with Stripe-hosted onboarding |
| 2 | **Payments** | One-time booking, paid with PaymentSheet |
| 3 | **Billing** | Care plan: subscription billed per week, month or year |
| 4 | **Invoicing** | Finalized invoice with a hosted page and a PDF (e.g. a bill for insurance) |

### Funds flow: direct charges

The sandbox platform profile is set to **"Sellers collect payments directly"**, with **negative balance liability: Stripe**. So:

- Each caregiver is a **merchant** with their own full Stripe Dashboard.
- Every payment, subscription and invoice is created **on the caregiver's account** (`Stripe-Account` header).
- The platform takes `PLATFORM_FEE_PERCENT` (default 10%) as an **application fee**.
- Stripe collects its processing fees from the caregiver and manages risk and disputes.

---

## 1. One-time setup

### Requirements

- Node.js 20+ and npm
- **Expo Go** on your phone (App Store or Google Play)
- Stripe CLI, for webhooks: `npm install -g @stripe/cli`
- Optional: `brew install cloudflared`, if the phone can't reach the Mac (see Troubleshooting)

### Stripe Dashboard (sandbox)

1. Create a **sandbox** and click **Go to sandbox**. You don't need a live account.
2. **Connect → Get started**, and finish the platform setup.
3. Check **Settings → Connect → Platform profile**:
   - Funds flow: *Sellers will collect payments directly*
   - Negative balance liability: *Stripe*
   - Both acknowledgements: *Completed*
4. **Developers → API keys**: you'll need the `pk_test_…` and `sk_test_…` keys in the next step.

### Install dependencies

```zsh
cd ~/CareApp/server && npm install
cd ~/CareApp/app && npm install
```

### Put the keys into `.env` (from the terminal)

The keys are typed in hidden and don't end up in shell history. Run this in **zsh**, all in one window:

```zsh
cd ~/CareApp/server
cp .env.example .env

read -s "SK?Secret key (sk_test_…): "; echo
read -s "PK?Publishable key (pk_test_…): "; echo
IP=$(ipconfig getifaddr en0)

sed -i '' "s|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=$SK|" .env
sed -i '' "s|^STRIPE_PUBLISHABLE_KEY=.*|STRIPE_PUBLISHABLE_KEY=$PK|" .env
sed -i '' "s|^BASE_URL=.*|BASE_URL=http://$IP:4242|" .env
echo "EXPO_PUBLIC_API_URL=http://$IP:4242" > ../app/.env

unset SK PK
chmod 600 .env
```

Check it without printing the keys:

```zsh
grep -E '^(STRIPE_SECRET_KEY|STRIPE_PUBLISHABLE_KEY|BASE_URL)=' .env | sed -E 's/(KEY=.{8}).*/\1…/'
cat ../app/.env
```

You should see `sk_test_…`, `pk_test_…` and your Mac's IP. If the IP is empty, try `ipconfig getifaddr en1`.

### `server/.env` reference

| Variable | Meaning |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…`. Test keys only: the server refuses live keys. |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…`. The app gets it from the server (`/config`). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…`, printed by `npm run webhooks` |
| `PLATFORM_FEE_PERCENT` | Platform cut, default `10` |
| `CURRENCY` | Default `eur` |
| `CONNECT_COUNTRY` | Country of caregiver accounts, default `MT` |
| `BASE_URL` | Address the phone uses to reach the server; also used for the onboarding return page |

`app/.env` holds only `EXPO_PUBLIC_API_URL`, which must be the same address as `BASE_URL`.

---

## 2. Run it

Use three terminals and keep them all open.

**Terminal 1: server**
```zsh
cd ~/CareApp/server && npm start
# → CareApp payments server on http://<IP>:4242
```

**Terminal 2: webhooks** (optional, but you'll see payment events)
```zsh
stripe login                       # once
cd ~/CareApp/server && npm run webhooks
```
Copy the `whsec_…` it prints into `server/.env` as `STRIPE_WEBHOOK_SECRET`, then restart Terminal 1. The script forwards both platform events and events from caregiver accounts (`--forward-connect-to`), which direct charges need.

**Terminal 3: app**
```zsh
cd ~/CareApp/app && npx expo start --clear
# or, if the phone isn't on the same network as Expo:
npx expo start --tunnel --clear
```
Scan the QR code with the camera (iOS) or Expo Go (Android).

**Quick connection check:** on the phone, open `http://<IP>:4242/config` in the browser. If you see `pk_test_…`, the app will connect too.

---

## 3. Test flow

### Caregiver onboarding (Connect)
1. In **1 · Caregiver**, enter a name and email and tap **Create caregiver + onboard**.
2. Stripe onboarding opens in a browser. In a sandbox use the test values:
   - Phone: `000 000 0000`, SMS code: `000000`
   - Date of birth: `01/01/1901`
   - Address: any; for identity verification, *Use test document* / address line `address_full_match`
   - Bank account: choose the test account Stripe offers in the form
3. When you reach "Onboarding finished", go back to the app and tap **Refresh**.
4. The caregiver shows **ready to receive payments** once their `card_payments` capability is `active`. Tap the caregiver to select them.

> If they still show `restricted` or `pending`, tap **Continue** to finish the remaining steps.

### Payments, plans and invoices
Fill in the client and service, then:

| Test | Button | Expected |
|---|---|---|
| One-time booking | **Pay €40** | PaymentSheet opens; after paying, "Booking paid" |
| Care plan | Pick *per week / month / year* → **Subscribe** | "Plan started"; an active subscription on the caregiver account |
| Invoice | **Create invoice + open** | The hosted invoice page opens; you can pay it there or download the PDF |

**Test cards** (any future date, any CVC, any postal code):

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | Success |
| `4000 0025 0000 3155` | Needs 3-D Secure (approve it in the pop-up) |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

### Where to check results in the Dashboard
- **Connect → Connected accounts →** the caregiver: payments, subscriptions and invoices live on their account.
- **Connect → Collected fees** (platform): the 10% application fees.
- Terminal 2 / Terminal 1: webhook events such as `payment_intent.succeeded`, `invoice.paid` and `customer.subscription.created`.

---

## 4. Troubleshooting

| Problem | Fix |
|---|---|
| App: *Can't reach server at …* | Is Terminal 1 running? Run `npm start` **in `server/`**, not in `CareApp/`. Did the IP change? Run `ipconfig getifaddr en0`, update both `.env` files, restart the server and `expo start --clear`. |
| Phone and Mac on university / public Wi-Fi | Such networks often block devices from seeing each other. Either use the phone's hotspot, or tunnel the server: `cloudflared tunnel --url http://localhost:4242`, then put the `https://….trycloudflare.com` URL into `EXPO_PUBLIC_API_URL` and `BASE_URL` and restart both. The URL changes on every cloudflared start. |
| `npm start` → *Could not read package.json* | You're in the wrong folder: `cd ~/CareApp/server`. |
| *Stripe no longer recommends Accounts v1…* | You're running old server code. Pull the latest `server.js`; it uses `stripe.v2.core.accounts`. |
| *losses collector…* / *Losses collector can only be "application"…* | The server's funds flow doesn't match the Platform profile. This code expects **direct charges + Stripe liability**. |
| Expo: *Cannot read properties of undefined (reading 'merchantIdentifier')* | In `app/app.json` the Stripe plugin needs an options object: `["@stripe/stripe-react-native", { "enableGooglePay": false }]`. |
| Payment buttons are greyed out | The selected caregiver hasn't finished onboarding: tap **Continue**, then **Refresh**. |
| App still uses an old server address | Restart Expo with `--clear`. `EXPO_PUBLIC_*` values are built into the bundle. |

## Not covered yet

Cancellation (last-minute) fee, refunds, guardian accounts for minors, caregiver-set price lists, and real auth or a database (caregivers are stored in `server/data.json`). This is a test slice only.
