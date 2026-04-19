import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'

const url = new URL(window.location.href)
const tokenFromUrl = url.searchParams.get('token')
if (tokenFromUrl) {
  sessionStorage.setItem('auth-token', tokenFromUrl)
  url.searchParams.delete('token')
  window.history.replaceState(null, '', url.toString())
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
