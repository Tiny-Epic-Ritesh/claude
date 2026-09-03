import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { signIn, BASE } from '../api.js';
import { s, t } from '../theme.js';

export default function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState('salesrm@bonanza.test');
  const [password, setPassword] = useState('bonanza');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signIn(email.trim(), password));
    } catch (err) {
      /* The API's own wording, including the rate limiter's "too many attempts",
         which a rep needs to be able to read and act on. */
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[s.screen, s.pad, { justifyContent: 'center' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={[s.h1, { marginBottom: 4 }]}>Bonanza CRM</Text>
      <Text style={[s.muted, { marginBottom: 24 }]}>Field app · {BASE}</Text>

      {error && (
        <View style={s.error}><Text style={s.errorText}>{error}</Text></View>
      )}

      <Text style={s.label}>Email</Text>
      <TextInput
        style={[s.input, { marginBottom: 16 }]}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        placeholder="you@bonanza.test"
        placeholderTextColor={t.muted}
      />

      <Text style={s.label}>Password</Text>
      <TextInput
        style={[s.input, { marginBottom: 24 }]}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholderTextColor={t.muted}
      />

      <TouchableOpacity style={s.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color={t.accentText} /> : <Text style={s.buttonText}>Sign in</Text>}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}
