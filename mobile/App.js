/**
 * Bonanza CRM — field app, throwaway shell.
 *
 * Three screens against the existing API: sign in, my leads, log a meeting with
 * a location. It exists to be put on two RMs' phones and argued with, not to be
 * extended. Deliberately absent: offline queueing, secure token storage,
 * biometric unlock and navigation — each is a decision recorded in
 * `docs/MOBILE-APP-SCOPE.md` and worth taking properly rather than by default.
 *
 * The token lives in memory only, so closing the app signs you out. That is the
 * honest placeholder for Keychain and Keystore rather than a stand-in that
 * looks finished.
 */

import { useState } from 'react';
import { SafeAreaView, StatusBar, Platform, View } from 'react-native';
import SignIn from './src/screens/SignIn.js';
import Leads from './src/screens/Leads.js';
import LogMeeting from './src/screens/LogMeeting.js';
import { setToken } from './src/api.js';
import { t } from './src/theme.js';

export default function App() {
  const [user, setUser] = useState(null);
  const [lead, setLead] = useState(null);

  const signOut = () => {
    setToken(null);
    setLead(null);
    setUser(null);
  };

  let screen;
  if (!user) screen = <SignIn onSignedIn={setUser} />;
  else if (lead) {
    screen = (
      <LogMeeting
        lead={lead}
        onCancel={() => setLead(null)}
        onDone={() => setLead(null)}
      />
    );
  } else screen = <Leads user={user} onOpen={setLead} onSignOut={signOut} />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={t.bg} />
      <View style={{ flex: 1, paddingTop: Platform.OS === 'android' ? 24 : 0 }}>
        {screen}
      </View>
    </SafeAreaView>
  );
}
