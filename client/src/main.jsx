import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Crm from './crm/Crm.jsx';
import DkycPortal from './dkyc/DkycPortal.jsx';
import PartnerPortal from './portal/PartnerPortal.jsx';
import './styles.css';

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
      <Routes>
        <Route path="/dkyc/*" element={<DkycPortal />} />
        <Route path="/portal/*" element={<PartnerPortal />} />
        <Route path="/*" element={<Crm />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
