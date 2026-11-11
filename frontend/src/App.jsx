import { Navigate, NavLink, Route, Routes } from 'react-router';
import PortfolioOverview from './components/PortfolioOverview.jsx';
import InstrumentDetail from './components/InstrumentDetail.jsx';
import PortfolioList from './components/PortfolioList.jsx';
import PortfolioDetail from './components/PortfolioDetail.jsx';
import PredictionsPage from './components/PredictionsPage.jsx';
import AuditPage from './components/AuditPage.jsx';
import Research from './components/Research.jsx';
import StressTest from './components/StressTest.jsx';
import Projection from './components/Projection.jsx';
import { t, LanguageToggle } from './i18n.jsx';

export default function App() {
  const linkClass = ({ isActive }) => (isActive ? 'active' : '');
  return (
    <div className="app">
      <header className="header">
        <h1>{t('Portfolio Tracker')}</h1>
        <div className="header-right">
          <nav>
            <NavLink end to="/" className={linkClass}>
              {t('Overview')}
            </NavLink>
            <NavLink to="/portfolios" className={linkClass}>
              {t('Portfolios')}
            </NavLink>
            <NavLink to="/stress" className={linkClass}>
              {t('Stress Test')}
            </NavLink>
            <NavLink to="/retirement" className={linkClass}>
              {t('Retirement Simulator')}
            </NavLink>
            <NavLink to="/research" className={linkClass}>
              {t('Research')}
            </NavLink>
            <NavLink to="/predictions" className={linkClass}>
              {t('Predictions')}
            </NavLink>
            <NavLink to="/audit" className={linkClass}>
              {t('Audit')}
            </NavLink>
          </nav>
          <LanguageToggle />
        </div>
      </header>

      <Routes>
        <Route path="/" element={<PortfolioOverview />} />
        <Route path="/instruments/:symbol" element={<InstrumentDetail />} />
        <Route path="/portfolios" element={<PortfolioList />} />
        <Route path="/portfolios/:id" element={<PortfolioDetail />} />
        <Route path="/stress" element={<StressTest />} />
        <Route path="/retirement" element={<Projection />} />
        {/* The page's old address, kept so bookmarks still work. */}
        <Route path="/projection" element={<Navigate to="/retirement" replace />} />
        <Route path="/research" element={<Research />} />
        <Route path="/predictions" element={<PredictionsPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Routes>
    </div>
  );
}
