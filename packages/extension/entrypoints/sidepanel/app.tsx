import { MemoryRouter, Routes, Route, useLocation, useNavigate, useParams } from 'react-router-dom';
import { HomePage } from './home';
import { RecordingDetail } from '@/components/recording/recording-detail';

/**
 * Side panel shell: a MemoryRouter with full-screen routes.
 *
 *   /                              home — feature tab bar + recording list
 *   /detail/:id                    a recording's call chain + endpoint contracts
 *
 * MemoryRouter (not Hash/Browser) keeps the route stack in memory only: reopening
 * the side panel starts back at home, which matches the "no persistence" choice.
 * The recording detail (Result) page's back button always returns to home.
 * Detail is its own route (not nested under home), so entering it replaces the
 * whole view — the tab bar only exists on the home route. Per-feature settings now
 * live inside each feature tab (e.g. MCP config in the MCP tab), so there is no
 * separate settings page.
 */
export default function App() {
  return (
    <MemoryRouter>
      <div className="h-screen">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/detail/:id" element={<DetailRoute />} />
        </Routes>
      </div>
    </MemoryRouter>
  );
}

/**
 * Bridges the :id route param and back-navigation into RecordingDetail. An
 * optional `{ tab }` in the route state reopens the detail on that bottom tab
 * instead of the default Result.
 */
function DetailRoute() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  if (!id) {
    navigate('/', { replace: true });
    return null;
  }
  const initialTab = (location.state as { tab?: 'result' | 'endpoints' } | null)?.tab;
  return <RecordingDetail recordingId={id} onBack={() => navigate('/')} initialTab={initialTab} />;
}
