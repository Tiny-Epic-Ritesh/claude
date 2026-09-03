/**
 * Bonanza CRM — field app, throwaway shell.
 *
 * Sign in, my leads, log a meeting with a location, and an offline queue so
 * none of that depends on having signal at the time. It exists to be put on two
 * RMs' phones and argued with, not to be extended.
 *
 * Still deliberately absent, each a decision in `docs/MOBILE-APP-SCOPE.md`
 * rather than something to add by default: secure token storage, biometric
 * unlock, and navigation. The token lives in memory, so closing the app signs
 * you out — an honest placeholder for Keychain and Keystore rather than a
 * stand-in that looks finished.
 *
 * The queue is deliberately *not* absent, because it is the one thing a field
 * app cannot be honest without: a rep in a basement who taps Save and loses the
 * meeting will stop using it that day.
 */

import { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar, Platform, View } from 'react-native';
import * as Network from 'expo-network';
import SignIn from './src/screens/SignIn.js';
import Leads from './src/screens/Leads.js';
import LogMeeting from './src/screens/LogMeeting.js';
import PendingBar from './src/PendingBar.js';
import * as queue from './src/queue.js';
import { setToken } from './src/api.js';
import { t } from './src/theme.js';

export default function App() {
  const [user, setUser] = useState(null);
  const [lead, setLead] = useState(null);
  const [online, setOnline] = useState(true);

  /* Flush when signal comes back, which is the moment that matters: a rep walks
     out of a basement and the morning's meetings should go on their own, without
     anybody remembering to press anything.

     Only while signed in — the queue needs the session token to send, and
     flushing without one would burn attempts against a 401. */
  useEffect(() => {
    if (!user) return undefined;

    let cancelled = false;
    const check = async (state) => {
      const up = !!(state?.isConnected && state?.isInternetReachable !== false);
      if (cancelled) return;
      setOnline(up);
      if (up) await queue.flush();
    };

    Network.getNetworkStateAsync().then(check).catch(() => {});
    const sub = Network.addNetworkStateListener(check);
    return () => { cancelled = true; sub?.remove?.(); };
  }, [user]);

  const signOut = () => {
    /* The queue survives sign-out on purpose. It holds work, not session state,
       and discarding a rep's unsent meetings because they signed out would be
       the worst possible reading of "log out". */
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
        {user && <PendingBar online={online} />}
        {screen}
      </View>
    </SafeAreaView>
  );
}
