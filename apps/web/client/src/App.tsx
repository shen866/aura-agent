import { AuraProvider, useAura } from "./AuraContext";
import { ToastProvider } from "./toast";
import { ChatView } from "./components/ChatView";
import { Header } from "./components/Header";
import { MonitorView } from "./components/MonitorView";
import { SettingsView } from "./components/SettingsView";

function Console() {
  const { app, config, secretStatus, view, applyConfigResult, applyConfigSnapshot } = useAura();

  return (
    <>
      <Header />
      <main className="app-main">
        <ChatView visible={view === "chat"} />
        <MonitorView visible={view === "monitor"} />
        <SettingsView
          app={app}
          config={config}
          secretStatus={secretStatus}
          visible={view === "settings"}
          onApplied={applyConfigResult}
          onReloaded={applyConfigSnapshot}
        />
      </main>
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AuraProvider>
        <Console />
      </AuraProvider>
    </ToastProvider>
  );
}
