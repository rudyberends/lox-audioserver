import React from 'react';
import './GlobalAlert.css';

type AlertPayload = { type: 'success' | 'error'; message: string } | null;

type GlobalAlertContextValue = {
  push: (alert: { type: 'success' | 'error'; message: string }) => void;
};

const GlobalAlertContext = React.createContext<GlobalAlertContextValue | null>(null);

export function GlobalAlertProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [alert, setAlert] = React.useState<AlertPayload>(null);
  const [hiding, setHiding] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);
  const hideTimerRef = React.useRef<number | null>(null);

  const push = React.useCallback((payload: { type: 'success' | 'error'; message: string }) => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
    }
    setHiding(false);
    setAlert(payload);
    timerRef.current = window.setTimeout(() => {
      setHiding(true);
      hideTimerRef.current = window.setTimeout(() => {
        setAlert(null);
        setHiding(false);
        hideTimerRef.current = null;
      }, 220);
      timerRef.current = null;
    }, 5000);
  }, []);

  React.useEffect(
    () => () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      if (hideTimerRef.current) {
        window.clearTimeout(hideTimerRef.current);
      }
    },
    [],
  );

  return (
    <GlobalAlertContext.Provider value={{ push }}>
      <div className="global-alert-layer">
        {alert && (
          <div className={`global-alert global-alert--${alert.type} ${hiding ? 'is-hiding' : ''}`}>
            <span>{alert.message}</span>
          </div>
        )}
      </div>
      {children}
    </GlobalAlertContext.Provider>
  );
}

export function useGlobalAlert(): GlobalAlertContextValue {
  const ctx = React.useContext(GlobalAlertContext);
  if (!ctx) {
    throw new Error('useGlobalAlert must be used within GlobalAlertProvider');
  }
  return ctx;
}
