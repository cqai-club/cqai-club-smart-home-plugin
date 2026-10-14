/** Manual browser fixture entry; served only by isolated UI verification tooling. */
import { createRoot } from 'react-dom/client'
import { HomePanel } from '../src/client/HomePanel'

const root = document.getElementById('root')
if (!root) throw new Error('Missing client preview root')
createRoot(root).render(<HomePanel />)
