import React from 'react'
import ReactDOM from 'react-dom/client'
import StudioLiteApp from './studio/StudioLiteApp'
import './studio/studio.css'

ReactDOM.createRoot(document.getElementById('studio-root')!).render(
    <React.StrictMode>
        <StudioLiteApp />
    </React.StrictMode>
)
