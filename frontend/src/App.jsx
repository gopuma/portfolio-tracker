import { NavLink, Route, Routes } from 'react-router-dom';
import PortfolioOverview from './components/PortfolioOverview.jsx';
import InstrumentDetail from './components/InstrumentDetail.jsx';
import PortfolioList from './components/PortfolioList.jsx';
import PortfolioDetail from './components/PortfolioDetail.jsx';
import PredictionsPage from './components/PredictionsPage.jsx';
import AuditPage from './components/AuditPage.jsx';

export default function App() {
  const linkClass = ({ isActive }) => (isActive ? 'active' : '');
  return (
    <div className="app">
      <header className="header">
        <h1>Portfolio Tracker</h1>
        <nav>
          <NavLink end to="/" className={linkClass}>
            Overview
          </NavLink>
          <NavLink to="/portfolios" className={linkClass}>
            Portfolios
          </NavLink>
          <NavLink to="/predictions" className={linkClass}>
            Predictions
          </NavLink>
          <NavLink to="/audit" className={linkClass}>
            Audit
          </NavLink>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<PortfolioOverview />} />
        <Route path="/instruments/:symbol" element={<InstrumentDetail />} />
        <Route path="/portfolios" element={<PortfolioList />} />
        <Route path="/portfolios/:id" element={<PortfolioDetail />} />
        <Route path="/predictions" element={<PredictionsPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Routes>
    </div>
  );
}
