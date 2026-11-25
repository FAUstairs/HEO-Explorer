import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Snowfall from './Snowfall'
import { initialiseTheme } from './theme'
import './styles.css'

initialiseTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Snowfall />
  </StrictMode>,
)
