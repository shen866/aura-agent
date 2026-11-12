import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./components/Icon";

export type ToastType = "info" | "success" | "error";
export type Toast = (message: string, type?: ToastType, timeout?: number) => void;

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  leaving?: boolean;
}

const ToastContext = createContext<Toast>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, leaving: true } : item))
    );
    const timer = setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
      timers.current.delete(id);
    }, 180);
    timers.current.set(id, timer);
  }, []);

  const toast = useCallback<Toast>(
    (message, type = "info", timeout = 4000) => {
      const id = nextId.current++;
      setItems((current) => [...current, { id, message, type }]);
      const timer = setTimeout(() => dismiss(id), timeout);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastRegion items={items} />
    </ToastContext.Provider>
  );
}

function ToastRegion({ items }: { items: ToastItem[] }) {
  return (
    <div className="toast-region" id="toast-region" aria-live="polite">
      {items.map((item) => (
        <div
          className={`toast is-${item.type}`}
          key={item.id}
          style={item.leaving ? { opacity: 0, transform: "translateY(6px)" } : undefined}
        >
          <Icon
            name={item.type === "success" ? "check" : item.type === "error" ? "alert" : "key"}
          />
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

export function useToast(): Toast {
  return useContext(ToastContext);
}
