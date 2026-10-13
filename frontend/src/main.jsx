/**
 * main.jsx
 * Entry point: mounts the React app into <div id="root"> in index.html.
 *  - BrowserRouter:   lets URLs like /costs show different pages without a reload
 *  - AuthProvider:    makes the logged-in user available to every page
 *  - TooltipProvider: shared settings for every shadcn tooltip
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from './auth';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <TooltipProvider delayDuration={150}>
          <App />
        </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
