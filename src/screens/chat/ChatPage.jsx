/* ============================================================
   ChatPage — layout shell for the AI Lawyer (route='lawyer').

   Desktop: 2-column (ChatSidebar + ChatWindow).
   Mobile (<768px): ChatSidebar becomes a left drawer with a scrim;
   ChatWindow gets a hamburger button in its header.
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { ChatSidebar } from './ChatSidebar';
import { ChatWindow } from './ChatWindow';
import { useChatSessions } from './useChatSessions';
import './chat.css';

function useIsNarrow(breakpoint = 768) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (e) => setNarrow(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [breakpoint]);
  return narrow;
}

export function ChatPage({ t, setRoute, lang: _lang }) {
  const {
    sessions,
    activeId,
    collapsed,
    loading,
    selectSession,
    createSession,
    deleteSession,
    renameSession,
    updateSessionLocal,
    toggleCollapsed,
  } = useChatSessions();

  const isNarrow = useIsNarrow(768);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Tap a row on mobile → close the drawer; on desktop it's always visible.
  const handleSelect = useCallback((id) => {
    selectSession(id);
    if (isNarrow) setDrawerOpen(false);
  }, [selectSession, isNarrow]);

  const handleCreate = useCallback(async () => {
    const id = await createSession();
    if (isNarrow) setDrawerOpen(false);
    return id;
  }, [createSession, isNarrow]);

  // ChatWindow needs an "ensure session" helper for the auto-create-on-first-send
  // path: if the user types before clicking "+ Новий чат", we POST a session
  // first and then proceed with the message.
  const ensureSession = useCallback(async () => {
    if (activeId && !activeId.startsWith('tmp-')) return activeId;
    return await createSession();
  }, [activeId, createSession]);

  const handleSessionMissing = useCallback((id) => {
    // Stale id (deleted on another device or in another tab). Drop the row
    // locally if it still appears in our list and reset the active id.
    deleteSession(id).catch(() => { /* row may already be gone */ });
  }, [deleteSession]);

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className={'page cop-page lc-page cl-page' + (collapsed && !isNarrow ? ' cl-page-collapsed' : '')}>
      {!isNarrow ? (
        <ChatSidebar
          sessions={sessions}
          activeId={activeId}
          collapsed={collapsed}
          loading={loading}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onDelete={deleteSession}
          onRename={renameSession}
          onToggleCollapsed={toggleCollapsed}
          isDrawer={false}
          t={t}
        />
      ) : null}

      <ChatWindow
        sessionId={activeId}
        ensureSession={ensureSession}
        onSessionPatched={updateSessionLocal}
        onSessionMissing={handleSessionMissing}
        onOpenSidebar={() => setDrawerOpen(true)}
        showMenuButton={isNarrow}
        t={t}
        setRoute={setRoute}
      />

      {isNarrow ? (
        <>
          <div
            className={'cl-scrim' + (drawerOpen ? ' cl-scrim-on' : '')}
            aria-hidden={drawerOpen ? 'false' : 'true'}
            onClick={() => setDrawerOpen(false)}
          />
          <div className={'cl-drawer-shell' + (drawerOpen ? ' cl-drawer-on' : '')}>
            <ChatSidebar
              sessions={sessions}
              activeId={activeId}
              collapsed={false}
              loading={loading}
              onSelect={handleSelect}
              onCreate={handleCreate}
              onDelete={deleteSession}
              onRename={renameSession}
              onToggleCollapsed={toggleCollapsed}
              onClose={() => setDrawerOpen(false)}
              isDrawer={true}
              t={t}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
