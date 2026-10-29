import { useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { MigrationView } from './pages/MigrationView';
import './styles.css';

export default function App() {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">KDI</span>
          <div>
            <strong>Kigali Digital Infrastructure</strong>
            <div className="sub">Managed IT Concierge · Operator Console</div>
          </div>
        </div>
        <div className="env">MVP · pilot</div>
      </header>
      <main className="container">
        {openId
          ? <MigrationView id={openId} onBack={() => setOpenId(null)} />
          : <Dashboard onOpen={setOpenId} />}
      </main>
      <footer className="footer">
        © {new Date().getFullYear()} Kigali Digital Infrastructure Ltd. All rights reserved.
      </footer>
    </div>
  );
}
