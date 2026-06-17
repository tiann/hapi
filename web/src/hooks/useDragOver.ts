import { useEffect, useState } from 'react'

/**
 * Returns true while the user is dragging files over the browser window.
 * Also suppresses the browser's default file-open behaviour for drags that
 * land outside an explicit drop zone.
 */
export function useDragOver(): boolean {
    const [isDraggingFiles, setIsDraggingFiles] = useState(false)

    useEffect(() => {
        const onDragEnter = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
                setIsDraggingFiles(true)
            }
        }

        // Only clear when the drag leaves the browser window entirely
        // (relatedTarget === null means the pointer moved outside the document)
        const onDragLeave = (e: DragEvent) => {
            if (e.relatedTarget === null) {
                setIsDraggingFiles(false)
            }
        }

        const clearDrag = () => setIsDraggingFiles(false)

        // Prevent the browser from opening the file when dropped outside a zone
        const preventDefault = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault()
            }
        }

        document.addEventListener('dragenter', onDragEnter)
        document.addEventListener('dragleave', onDragLeave)
        document.addEventListener('dragend', clearDrag)
        document.addEventListener('drop', clearDrag)
        document.addEventListener('dragover', preventDefault)

        return () => {
            document.removeEventListener('dragenter', onDragEnter)
            document.removeEventListener('dragleave', onDragLeave)
            document.removeEventListener('dragend', clearDrag)
            document.removeEventListener('drop', clearDrag)
            document.removeEventListener('dragover', preventDefault)
        }
    }, [])

    return isDraggingFiles
}
