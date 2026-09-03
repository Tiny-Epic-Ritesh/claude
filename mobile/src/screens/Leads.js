import { useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { api } from '../api.js';
import { s, t } from '../theme.js';

export default function Leads({ user, onOpen, onSignOut }) {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setError(null);
    try {
      /* Already scoped server-side by role and by book, so there is no filter
         to apply here and no way for the phone to widen it. */
      setLeads(await api.get('/leads?limit=50'));
    } catch (err) {
      setError(err.message);
      setLeads([]);
    }
  };

  useEffect(() => { load(); }, []);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (leads === null) {
    return (
      <View style={[s.screen, { justifyContent: 'center' }]}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.pad, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.h1}>My leads</Text>
          <Text style={s.muted}>{user?.name} · {leads.length} in your book</Text>
        </View>
        <TouchableOpacity onPress={onSignOut}>
          <Text style={[s.muted, { padding: 8 }]}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {error && (
        <View style={[s.error, { marginHorizontal: 16 }]}><Text style={s.errorText}>{error}</Text></View>
      )}

      <FlatList
        data={leads}
        keyExtractor={(l) => String(l.id)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} />}
        ListEmptyComponent={<Text style={s.muted}>No leads in your book.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.card} onPress={() => onOpen(item)}>
            <Text style={s.h2}>{item.name}</Text>
            <Text style={[s.muted, { marginTop: 4 }]}>
              {/* The API masks the number by role; whatever arrives is shown as it arrives. */}
              {[item.mobile, item.city, item.stage].filter(Boolean).join(' · ')}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
