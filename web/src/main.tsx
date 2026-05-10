import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './components/common/common.css';
import { initI18n } from './i18n/index.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

const ShareViewPage = lazy(() => import('./pages/ShareViewPage.tsx'));

async function bootstrap() {
  await initI18n();
  const { default: App } = await import('./App.tsx');

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route
              path="/share/:shareId"
              element={
                <Suspense fallback={<div className="share-loading">Loading...</div>}>
                  <ShareViewPage />
                </Suspense>
              }
            />
            <Route path="*" element={<App />} />
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
