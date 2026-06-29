/* ============================================================
   AG Lex — useExitGuard: intercept in-app navigation + browser unload
   while document processing is in flight.

   No react-router-dom in this app — navigation is the App-level
   `setRoute` state. The hook returns a `guardedSetRoute` you wrap your
   real setRoute with: if processing is active, the requested route is
   queued and `pendingRoute` flips to non-null so a modal can prompt.
   `confirmLeave` then runs the queued navigation; `cancelLeave` drops it.
   Tab close / refresh is covered by the standard beforeunload prompt.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useExitGuard(isProcessing) {
  const [pendingRoute, setPendingRoute] = useState(null);
  const setRouteRef = useRef(null);

  // beforeunload handles tab close, reload, and address-bar nav. The browser
  // owns the confirmation UI here; our modal only fires for in-app navigation.
  useEffect(() => {
    if (!isProcessing) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isProcessing]);

  // ESC = cancel — matches the modal's keyboard contract.
  useEffect(() => {
    if (!pendingRoute) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPendingRoute(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingRoute]);

  const guard = useCallback(
    (setRoute) => {
      setRouteRef.current = setRoute;
      return (nextRoute) => {
        if (!isProcessing) {
          setRoute(nextRoute);
          return;
        }
        setPendingRoute(nextRoute);
      };
    },
    [isProcessing],
  );

  const confirmLeave = useCallback(() => {
    const route = pendingRoute;
    setPendingRoute(null);
    if (route != null && setRouteRef.current) {
      setRouteRef.current(route);
    }
  }, [pendingRoute]);

  const cancelLeave = useCallback(() => setPendingRoute(null), []);

  return {
    isBlocked: pendingRoute != null,
    pendingRoute,
    guard,
    confirmLeave,
    cancelLeave,
  };
}
