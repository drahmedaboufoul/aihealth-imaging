/*
 * useViewerRoom — live co-viewing over Supabase Realtime (broadcast + presence).
 *
 * Operator: publishes packed view-state frames (throttled + deduped) on the
 *   room channel so followers mirror the navigation.
 * Follower: receives state frames and hands them to onRemoteState; also learns
 *   from presence whether an operator is currently live.
 *
 * The channel is keyed by study id (roomChannelName). Broadcast + presence
 * need only the anon key, so an anonymous share-link follower can join without
 * a Supabase auth session. Nothing but ephemeral view state crosses the wire.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { roomChannelName, statesEqual, throttle } from '../lib/viewerRoom';

const PUBLISH_MS = 90; // ~11 fps cap on outbound state frames

export function useViewerRoom({ roomId, role, onRemoteState, displayName } = {}) {
  const enabled = !!roomId && (role === 'operator' || role === 'follower');
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState(0);
  const [operatorPresent, setOperatorPresent] = useState(false);
  const [operatorName, setOperatorName] = useState(null);

  const channelRef = useRef(null);
  const lastSentRef = useRef(null);
  const onRemoteRef = useRef(onRemoteState);
  onRemoteRef.current = onRemoteState;

  useEffect(() => {
    if (!enabled) { setConnected(false); return; }
    let cancelled = false;

    const channel = supabase.channel(roomChannelName(roomId), {
      config: {
        broadcast: { self: false },
        presence: { key: `${role}-${Math.random().toString(36).slice(2, 8)}` },
      },
    });
    channelRef.current = channel;

    // Follower applies incoming operator state.
    channel.on('broadcast', { event: 'state' }, ({ payload }) => {
      if (role === 'follower' && payload) onRemoteRef.current?.(payload);
    });

    const syncPresence = () => {
      const state = channel.presenceState();
      const members = Object.values(state).flat();
      setParticipants(members.length);
      const op = members.find((m) => m?.role === 'operator');
      setOperatorPresent(!!op);
      setOperatorName(op?.name || null);
    };
    channel.on('presence', { event: 'sync' }, syncPresence);
    channel.on('presence', { event: 'join' }, syncPresence);
    channel.on('presence', { event: 'leave' }, syncPresence);

    channel.subscribe(async (status) => {
      if (cancelled) return;
      if (status === 'SUBSCRIBED') {
        setConnected(true);
        try {
          await channel.track({ role, name: displayName || (role === 'operator' ? 'Presenter' : 'Guest') });
        } catch { /* presence best-effort */ }
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setConnected(false);
      }
    });

    return () => {
      cancelled = true;
      setConnected(false);
      setParticipants(0);
      setOperatorPresent(false);
      try { supabase.removeChannel(channel); } catch { /* already gone */ }
      channelRef.current = null;
      lastSentRef.current = null;
    };
  }, [enabled, roomId, role, displayName]);

  // Throttled operator publisher. Recreated when the channel identity changes.
  const publishThrottledRef = useRef(null);
  useEffect(() => {
    publishThrottledRef.current = throttle((state) => {
      const ch = channelRef.current;
      if (!ch) return;
      if (statesEqual(state, lastSentRef.current)) return;
      lastSentRef.current = state;
      ch.send({ type: 'broadcast', event: 'state', payload: state });
    }, PUBLISH_MS);
    return () => publishThrottledRef.current?.cancel?.();
  }, [enabled, roomId]);

  const publish = useCallback((state) => {
    if (role !== 'operator' || !state) return;
    publishThrottledRef.current?.(state);
  }, [role]);

  return { connected, participants, operatorPresent, operatorName, publish };
}
