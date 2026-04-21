import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Intake } from './routes/Intake'
import { Research } from './routes/Research'
import { Resume } from './routes/Resume'
import { Jobs } from './routes/Jobs'
import { Interview } from './routes/Interview'
import { InputPage } from './drill/InputPage'
import { DrillPage } from './drill/DrillPage'

export function App() {
  return (
    <Routes>
      {/* Drill routes — no sidebar layout */}
      <Route path="/drill" element={<InputPage />} />
      <Route path="/drill/:sessionId" element={<DrillPage />} />

      {/* Main app routes — wrapped in Layout */}
      <Route
        path="*"
        element={
          <Layout>
            <Routes>
              <Route path="/" element={<Navigate to="/intake" replace />} />
              <Route path="/intake" element={<Intake />} />
              <Route path="/research" element={<Research />} />
              <Route path="/resume" element={<Resume />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/interview" element={<Interview />} />
            </Routes>
          </Layout>
        }
      />
    </Routes>
  )
}
