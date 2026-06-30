import { createRoot } from 'react-dom/client';
import App from './App';
import { DocumentProcessingProvider } from './contexts/DocumentProcessingContext';
import './styles/styles.css';
import './styles/analysis.css';
import './styles/screens.css';

createRoot(document.getElementById('root')).render(
  <DocumentProcessingProvider>
    <App />
  </DocumentProcessingProvider>,
);
