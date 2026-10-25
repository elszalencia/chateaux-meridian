import './app/pathRedirect';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { I18nProvider } from './app/i18n';
import { DemoProvider } from './app/demo';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <DemoProvider>
        <App />
      </DemoProvider>
    </I18nProvider>
  </StrictMode>,
);
