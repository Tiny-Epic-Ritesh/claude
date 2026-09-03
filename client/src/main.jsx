import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Loading } from './components/ui.jsx';
import './styles.css';

/**
 * One surface per visitor.
 *
 * These were static imports, so every visitor downloaded all three: an RM
 * carried the account-opening portal, and an applicant opening an account -- a
 * member of the public, quite possibly on mobile data -- carried the entire
 * internal CRM, every cockpit and the whole of Setup with it.
 *
 * Deliberately not prefetched, unlike the screens inside the CRM. Nobody uses
 * two of these: an applicant will never open the CRM, and warming it for them
 * would hand back exactly what this split saves.
 */
const Crm = lazy(() => import('./crm/Crm.jsx'));
const DkycPortal = lazy(() => import('./dkyc/DkycPortal.jsx'));
const PartnerPortal = lazy(() => import('./portal/PartnerPortal.jsx'));

/**
 * Three surfaces, one build — all mounted under the /ai-crm base path:
 *   /ai-crm/dkyc/*   public self-service KYC portal (no login)
 *   /ai-crm/portal/* partner portal (separate partner auth — BRD OD-10)
 *   /ai-crm/*        the internal CRM (11 role cockpits)
 *
 * BrowserRouter basename="/ai-crm" means every <Link to="…"> and useNavigate()
 * call is automatically prefixed — no route inside the app needs to know it lives
 * under a sub-path.  Bare "/" (i.e. the server root) is handled server-side with
 * a 301 redirect to /ai-crm/.
 */
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/ai-crm">
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/dkyc/*" element={<DkycPortal />} />
          <Route path="/portal/*" element={<PartnerPortal />} />
          <Route path="/*" element={<Crm />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
