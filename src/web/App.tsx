import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Intake } from './routes/Intake'
import { Research } from './routes/Research'
import { Resume } from './routes/Resume'
import { Jobs } from './routes/Jobs'
import { Interview } from './routes/Interview'

export function App() {
  useEffect(() => {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('token')
    if (token) {
      sessionStorage.setItem('auth-token', token)
      url.searchParams.delete('token')
      window.history.replaceState(null, '', url.toString())
    }
  }, [])

  return (
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
  )
}
