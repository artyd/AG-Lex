import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/styles.css';
import './styles/analysis.css';
import './styles/screens.css';
import './screens/analysis/pdfViewer.css';

createRoot(document.getElementById('root')).render(<App />);
