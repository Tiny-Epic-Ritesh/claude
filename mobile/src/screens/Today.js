import { useEffect, useState } from 'react';
import {
  View, Text, FlatList, ActivityIndicator, RefreshControl, TouchableOpacity,
} from 'react-native';
import { api } from '../api.js';
import { s, t } from '../theme.js';

/**
 * The day, as one list.
 *
 * `GET /api/calendar` already returns meetings and tasks on a single timeline —
 * `kind` says which — so this screen does not merge two feeds, it renders one.
 * That matters on a phone: a rep wants to know what is next, not which system
 * it came from.
 */

const time = (stamp) => {
  if (!stamp) return '';
  const d = new Date(`${stamp.replace(' ', 'T')}Z`);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function Today({ onOpenLead }) {
  const [day, setDay] = useState(null);
  const [counts, setCounts] = useState(null);
  const [simulated, setSimulated] = useState(false);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const data = await api.get('/calendar?days=1');
      setDay(data.days?.[0] ?? { date: data.from, items: [] });
      setCounts(data.counts ?? null);
      /* The adapter says whether it is reading a real diary or simulating one.
         Showing meetings that are not real without saying so is how somebody
         misses an actual appointment. */
      setSimulated(data.source?.live === false);
    } catch (err) {
      setError(err.message);
      setDay({ items: [] });
    }
  };

  useEffect(() => { load(); }, []);

  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (day === null) {
    return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={t.accent} /></View>;
  }

  const items = [...(day.items || [])].sort(
    (a, b) => String(a.starts_at || '').localeCompare(String(b.starts_at || '')),
  );

  return (
    <View style={s.screen}>
      <View style={s.pad}>
        <Text style={s.h1}>Today</Text>
        <Text style={s.muted}>
          {day.date}
          {counts && ` · ${counts.meetings} meetings · ${counts.tasks} tasks`}
        </Text>
      </View>

      {simulated && (
        <View style={[s.notice, { marginHorizontal: 16 }]}>
          <Text style={s.muted}>
            Simulated diary — Outlook is not connected, so these meetings are not real.
          </Text>
        </View>
      )}

      {error && <View style={[s.error, { marginHorizontal: 16 }]}><Text style={s.errorText}>{error}</Text></View>}

      <FlatList
        data={items}
        keyExtractor={(i) => `${i.kind}-${i.id}`}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} />}
        ListEmptyComponent={<Text style={s.muted}>Nothing in the diary today.</Text>}
        renderItem={({ item }) => {
          const meeting = item.kind === 'meeting';
          const title = item.subject || item.title;
          return (
            <TouchableOpacity
              style={[s.card, {
                flexDirection: 'row',
                gap: 12,
                opacity: item.cancelled ? 0.5 : 1,
                // A meeting is where the app earns its keep, so it is the one
                // with the accent down its edge.
                borderLeftColor: meeting ? t.accent : t.border,
                borderLeftWidth: meeting ? 3 : 1,
              }]}
              disabled={!item.lead_id}
              onPress={() => item.lead_id && onOpenLead(item.lead_id, item.lead_name)}
            >
              <Text style={[s.muted, { width: 52, fontVariant: ['tabular-nums'] }]}>
                {item.all_day ? 'all day' : time(item.starts_at)}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={s.h2}>{title}{item.cancelled ? ' · cancelled' : ''}</Text>
                <Text style={[s.muted, { marginTop: 4 }]}>
                  {[
                    meeting ? (item.location || 'No location') : 'Task',
                    item.lead_name,
                  ].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {item.lead_id && <Text style={[s.muted, { alignSelf: 'center' }]}>›</Text>}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}
