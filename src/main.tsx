import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './app/styles.css';
import { App } from './app/App';

createRoot(document.getElementById('root')!).render(<App />);
