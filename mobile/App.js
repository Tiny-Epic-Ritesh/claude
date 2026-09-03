/**
 * Bonanza CRM — field app, throwaway shell.
 *
 * Today, my leads, my tasks, and logging a meeting with a location — with an
 * offline queue underneath so none of it depends on having signal at the time.
 * It exists to be put on two RMs' phones and argued with, not to be extended.
 *
 * Still deliberately absent, each a decision in `docs/MOBILE-APP-SCOPE.md`
 * rather than something to add by default: secure token storage, biometric
 * unlock, and a navigation library. The token lives in memory, so closing the
 * app signs you out — an honest placeholder for Keychain and Keystore rather
 * than a stand-in that looks finished.
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
import Tasks from './src/screens/Tasks.js';
import Today from './src/screens/Today.js';
import LogMeeting from './src/screens/LogMeeting.js';
import PendingBar from './src/PendingBar.js';
import TabBar from './src/TabBar.js';
import * as queue from './src/queue.js';
import { setToken } from './src/api.js';
import { t } from './src/theme.js';

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('today');
  const [lead, setLead] = useState(null);
  const [online, setOnline] = useState(true);
  const [waiting, setWaiting] = useState(0);

  /* Flush when signal comes back, which is the moment that matters: a rep walks
     out of a basement and the morning's work should go on its own, without
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

  // The tab badge, so unsent work is visible from wherever you are standing.
  useEffect(() => queue.onChange(
    (items) => setWaiting(items.filter((i) => i.state === 'queued').length),
  ), []);

  const signOut = () => {
    /* The queue survives sign-out on purpose. It holds work, not session state,
       and discarding a rep's unsent meetings because they signed out would be
       the worst possible reading of "log out". */
    setToken(null);
    setLead(null);
    setUser(null);
  };

  if (!user) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <StatusBar barStyle="light-content" backgroundColor={t.bg} />
        <SignIn onSignedIn={setUser} />
      </SafeAreaView>
    );
  }

  // A meeting form takes the whole screen: it is one task, and the tabs would
  // only offer a way to lose half-typed notes.
  if (lead) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <StatusBar barStyle="light-content" backgroundColor={t.bg} />
        <View style={{ flex: 1, paddingTop: Platform.OS === 'android' ? 24 : 0 }}>
          <PendingBar online={online} />
          <LogMeeting lead={lead} onCancel={() => setLead(null)} onDone={() => setLead(null)} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={t.bg} />
      <View style={{ flex: 1, paddingTop: Platform.OS === 'android' ? 24 : 0 }}>
        <PendingBar online={online} />

        <View style={{ flex: 1 }}>
          {tab === 'today' && (
            <Today onOpenLead={(id, name) => setLead({ id, name: name || 'Lead' })} />
          )}
          {tab === 'leads' && <Leads user={user} onOpen={setLead} onSignOut={signOut} />}
          {tab === 'tasks' && <Tasks />}
        </View>

        <TabBar active={tab} onChange={setTab} badges={{ tasks: waiting || undefined }} />
      </View>
    </SafeAreaView>
  );
}
