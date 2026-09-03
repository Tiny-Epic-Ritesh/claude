import { View, Text, TouchableOpacity } from 'react-native';
import { t } from './theme.js';

/**
 * Three destinations, no navigation library.
 *
 * The scope document lists navigation as deliberately absent, and it still is:
 * there is no back stack, no deep links and no router. This is a segmented
 * control over three screens, which is what three screens need. Reaching for
 * expo-router here would be choosing an architecture for an app whose shape is
 * still being argued about.
 */

const TABS = [
  { key: 'today', label: 'Today' },
  { key: 'leads', label: 'Leads' },
  { key: 'tasks', label: 'Tasks' },
];

export default function TabBar({ active, onChange, badges = {} }) {
  return (
    <View style={{
      flexDirection: 'row',
      borderTopColor: t.border,
      borderTopWidth: 1,
      backgroundColor: t.surface,
    }}
    >
      {TABS.map((tab) => {
        const on = active === tab.key;
        const badge = badges[tab.key];
        return (
          <TouchableOpacity
            key={tab.key}
            onPress={() => onChange(tab.key)}
            style={{
              flex: 1,
              paddingVertical: 14,
              alignItems: 'center',
              borderTopColor: on ? t.accent : 'transparent',
              borderTopWidth: 2,
              marginTop: -1,
            }}
          >
            <Text style={{
              color: on ? t.accent : t.muted,
              fontWeight: on ? '700' : '600',
              fontSize: 14,
            }}
            >
              {tab.label}
              {badge ? ` · ${badge}` : ''}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
