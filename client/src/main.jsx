import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Crm from './crm/Crm.jsx';
import DkycPortal from './dkyc/DkycPortal.jsx';
import PartnerPortal from './portal/PartnerPortal.jsx';
import './styles.css';

/**
 * Three surfaces, one build:
 *   /dkyc/*   public self-service KYC portal (no login)
 *   /portal/* partner portal (separate partner auth — BRD OD-10)
 *   /*        the internal CRM (11 role cockpits)
 */
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/dkyc/*" element={<DkycPortal />} />
        <Route path="/portal/*" element={<PartnerPortal />} />
        <Route path="/*" element={<Crm />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
