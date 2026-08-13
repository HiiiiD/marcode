import { createRoot } from 'react-dom/client';

function App() {
  return <div className="p-3 text-sm">Agents panel ready.</div>;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
