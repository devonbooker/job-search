import { useEffect, useState } from 'react'
import { api } from '../api'

interface Job {
  id: number
  job_title: string
  company: string
  link?: string
  stage: string
  source?: string
  notes?: string
}

const STAGES = ['not_applied','applied','phone_screening','interview','booked','offer_received','accepted','rejected']

export function Jobs() {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try { setJobs(await api.listJobs() as Job[]) } catch (err: any) { setError(err.message) }
  }

  useEffect(() => { load() }, [])

  async function updateStage(id: number, stage: string) {
    await api.updateJob(id, { stage })
    await load()
  }

  async function addManual() {
    const title = prompt('Job title?'); if (!title) return
    const company = prompt('Company?'); if (!company) return
    await api.createJob({ job_title: title, company })
    await load()
  }

  if (error) return <div><h2>Jobs</h2><p style={{ color: 'var(--danger)' }}>{error}</p></div>
  if (!jobs) return <div><h2>Jobs</h2><p>Loading...</p></div>

  return (
    <div>
      <h2>Jobs <button onClick={addManual}>+ Add</button></h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th align="left">Title</th><th align="left">Company</th><th align="left">Stage</th></tr></thead>
        <tbody>
          {jobs.map(j => (
            <tr key={j.id}>
              <td>{j.link ? <a href={j.link} target="_blank">{j.job_title}</a> : j.job_title}</td>
              <td>{j.company}</td>
              <td>
                <select value={j.stage} onChange={(e) => updateStage(j.id, e.target.value)}>
                  {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
