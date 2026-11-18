// CareApp: payments test screen
// Tests Stripe Connect (caregiver onboarding), Payments (one-time booking),
// Billing (weekly / monthly / yearly plan) and Invoicing (bill for insurance).
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { initStripe, StripeProvider, useStripe } from '@stripe/stripe-react-native';

const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4242';

type Caregiver = { id: string; name: string; email: string; chargesEnabled: boolean; transfersStatus?: string };
type Interval = 'week' | 'month' | 'year';
type PayResponse = { clientSecret: string; customer: string; ephemeralKey: string; stripeAccountId: string };

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json;
}

export default function App() {
  const [publishableKey, setPublishableKey] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<{ publishableKey: string }>('/config')
      .then((c) => setPublishableKey(c.publishableKey))
      .catch((e) => setError(`Can't reach server at ${API}: ${e.message}`));
  }, []);

  if (!publishableKey) {
    return (
      <SafeAreaView style={s.center}>
        <Text>{error ?? 'Connecting to server…'}</Text>
      </SafeAreaView>
    );
  }
  return (
    <StripeProvider publishableKey={publishableKey} urlScheme="careapp">
      <PaymentsTest publishableKey={publishableKey} />
    </StripeProvider>
  );
}

function PaymentsTest({ publishableKey }: { publishableKey: string }) {
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);

  // form fields
  const [cgName, setCgName] = useState('Anna Caregiver');
  const [cgEmail, setCgEmail] = useState('anna@example.com');
  const [clientName, setClientName] = useState('Test Client');
  const [clientEmail, setClientEmail] = useState('client@example.com');
  const [service, setService] = useState('Elderly care visit');
  const [amount, setAmount] = useState('40');
  const [interval, setPlanInterval] = useState<Interval>('month');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e: any) { Alert.alert('Error', e.message); } finally { setBusy(false); }
  };

  const refresh = useCallback(() => run(async () => {
    const list = await api<Caregiver[]>('/api/caregivers');
    setCaregivers(list);
    if (!selected && list[0]) setSelected(list[0].id);
  }), [selected]);

  useEffect(() => { refresh(); }, []);

  // 1. Connect
  const addCaregiver = () => run(async () => {
    const { id } = await api<{ id: string }>('/api/caregivers', { name: cgName, email: cgEmail });
    setSelected(id);
    const { url } = await api<{ url: string }>(`/api/caregivers/${id}/onboard`, {});
    await WebBrowser.openBrowserAsync(url);
    await refresh();
  });
  const continueOnboarding = (id: string) => run(async () => {
    const { url } = await api<{ url: string }>(`/api/caregivers/${id}/onboard`, {});
    await WebBrowser.openBrowserAsync(url);
    await refresh();
  });

  // Shared PaymentSheet flow for bookings and plans
  // Direct charges: the payment lives on the caregiver's account, so point the SDK at it first
  const pay = async (r: PayResponse, done: string) => {
    const { clientSecret, customer, ephemeralKey, stripeAccountId } = r;
    await initStripe({ publishableKey, stripeAccountId, urlScheme: 'careapp' });
    const init = await initPaymentSheet({
      merchantDisplayName: 'CareApp',
      paymentIntentClientSecret: clientSecret,
      customerId: customer,
      customerEphemeralKeySecret: ephemeralKey,
      defaultBillingDetails: { name: clientName, email: clientEmail },
      returnURL: 'careapp://stripe-redirect',
    });
    if (init.error) throw new Error(init.error.message);
    const result = await presentPaymentSheet();
    if (result.error) {
      if (result.error.code !== 'Canceled') throw new Error(result.error.message);
      return;
    }
    Alert.alert('Success', done);
  };

  const body = () => ({ caregiverId: selected, service, amount, clientName, clientEmail });

  // 2. Payments
  const bookOnce = () => run(async () => {
    const r = await api<PayResponse>('/api/bookings', body());
    await pay(r, `Booking paid: €${amount}`);
  });

  // 3. Billing
  const subscribe = () => run(async () => {
    const r = await api<PayResponse>('/api/plans', { ...body(), interval });
    await pay(r, `Plan started: €${amount} per ${interval}`);
  });

  // 4. Invoicing
  const invoice = () => run(async () => {
    const r = await api<{ hostedInvoiceUrl: string }>('/api/invoices', { ...body(), description: service });
    await WebBrowser.openBrowserAsync(r.hostedInvoiceUrl);
  });

  const ready = caregivers.find((c) => c.id === selected)?.chargesEnabled;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>CareApp · Stripe test</Text>
        <Text style={s.muted}>Test mode. Card: 4242 4242 4242 4242, any future date, any CVC.</Text>

        <Section title="1 · Caregiver (Connect)">
          <Field label="Name" value={cgName} onChangeText={setCgName} />
          <Field label="Email" value={cgEmail} onChangeText={setCgEmail} keyboardType="email-address" />
          <Button title="Create caregiver + onboard" onPress={addCaregiver} disabled={busy} />
          {caregivers.map((c) => (
            <Pressable key={c.id} onPress={() => setSelected(c.id)} style={[s.row, selected === c.id && s.rowSel]}>
              <View style={{ flex: 1 }}>
                <Text style={s.bold}>{c.name}</Text>
                <Text style={s.muted}>{c.id} · {c.chargesEnabled ? "ready to receive payments" : `onboarding: ${c.transfersStatus ?? "not started"}`}</Text>
              </View>
              {!c.chargesEnabled && <Text style={s.link} onPress={() => continueOnboarding(c.id)}>Continue</Text>}
            </Pressable>
          ))}
          <Button title="Refresh" onPress={refresh} disabled={busy} secondary />
        </Section>

        <Section title="Client & service">
          <Field label="Client name" value={clientName} onChangeText={setClientName} />
          <Field label="Client email" value={clientEmail} onChangeText={setClientEmail} keyboardType="email-address" />
          <Field label="Service" value={service} onChangeText={setService} />
          <Field label="Price (EUR)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          {!ready && <Text style={s.warn}>Select a caregiver who finished onboarding to test payments.</Text>}
        </Section>

        <Section title="2 · One-time booking (Payments)">
          <Button title={`Pay €${amount}`} onPress={bookOnce} disabled={busy || !ready} />
        </Section>

        <Section title="3 · Care plan (Billing)">
          <View style={s.chips}>
            {(['week', 'month', 'year'] as Interval[]).map((i) => (
              <Pressable key={i} onPress={() => setPlanInterval(i)} style={[s.chip, interval === i && s.chipSel]}>
                <Text style={interval === i ? s.chipTextSel : undefined}>per {i}</Text>
              </Pressable>
            ))}
          </View>
          <Button title={`Subscribe €${amount} / ${interval}`} onPress={subscribe} disabled={busy || !ready} />
        </Section>

        <Section title="4 · Invoice for insurance (Invoicing)">
          <Button title="Create invoice + open" onPress={invoice} disabled={busy || !ready} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <Text style={s.h2}>{title}</Text>
      {children}
    </View>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} autoCapitalize="none" {...props} />
    </View>
  );
}

function Button({ title, onPress, disabled, secondary }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={[s.btn, secondary && s.btnSec, disabled && { opacity: 0.4 }]}>
      <Text style={[s.btnText, secondary && { color: '#635bff' }]}>{title}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7fb' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  page: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  h2: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  muted: { color: '#6b7280', fontSize: 12 },
  bold: { fontWeight: '600' },
  warn: { color: '#b45309', fontSize: 12 },
  link: { color: '#635bff', fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 14 },
  label: { fontSize: 12, color: '#374151', marginBottom: 2 },
  input: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, padding: 10, fontSize: 15 },
  btn: { backgroundColor: '#635bff', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 6 },
  btnSec: { backgroundColor: '#eef0ff' },
  btnText: { color: '#fff', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb', marginTop: 8 },
  rowSel: { borderColor: '#635bff', backgroundColor: '#f5f5ff' },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: '#eef0ff' },
  chipSel: { backgroundColor: '#635bff' },
  chipTextSel: { color: '#fff' },
});
