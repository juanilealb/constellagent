import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Tab handling when terminal is focused
      if (e.key === 'Tab' && (e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          // Shift+Tab: ghostty-web sends \t for both Tab and Shift+Tab
          e.preventDefault()
          e.stopPropagation()
          const s = useAppStore.getState()
          const tab = s.tabs.find((t) => t.id === s.activeTabId)
          if (tab?.type === 'terminal') {
            window.api.pty.write(tab.ptyId, '\x1b[Z')
          }
        } else {
          // Regular Tab: prevent browser focus navigation, let ghostty-web handle it
          e.preventDefault()
        }
        return
      }

      // Shift+Enter handling when terminal is focused
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
        && (e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        // Write kitty keyboard protocol so CLIs (e.g. Claude Code) can distinguish
        // Shift+Enter (new line) from Enter (submit).
        e.preventDefault()
        e.stopPropagation()
        const s = useAppStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab?.type === 'terminal') {
          window.api.pty.write(tab.ptyId, '\x1b[13;2u')
        }
        return
      }

      // Windows terminal line-editing conventions.
      if ((e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        const s = useAppStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab?.type === 'terminal') {
          if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === 'ArrowLeft') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x1bb') // Alt+B — previous word
            return
          }
          if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x1bf') // Alt+F — next word
            return
          }
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === 'Home') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x01') // Ctrl+A — beginning of line
            return
          }
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === 'End') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x05') // Ctrl+E — end of line
            return
          }
          if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === 'Backspace') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x17') // Ctrl+W — delete previous word
            return
          }
        }
      }

      const meta = e.ctrlKey
      const shift = e.shiftKey
      const alt = e.altKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (!meta) return

      const store = useAppStore.getState()

      // Stop event from reaching terminal (capture phase — must stopPropagation)
      function consume() {
        e.preventDefault()
        e.stopPropagation()
      }

      // ── Quick open: Ctrl+P ──
      if (!shift && !alt && (key === 'p' || e.code === 'KeyP')) {
        consume()
        store.toggleQuickOpen()
        return
      }

      // ── Tab switching: Ctrl+1-9 ──
      if (!shift && !alt && e.key >= '1' && e.key <= '9') {
        consume()
        store.switchToTabByIndex(parseInt(e.key) - 1)
        return
      }

      // ── Workspace switching: Ctrl+Shift+Up / Ctrl+Shift+Down ──
      if (shift && !alt && e.key === 'ArrowUp') {
        consume()
        store.prevWorkspace()
        return
      }
      if (shift && !alt && e.key === 'ArrowDown') {
        consume()
        store.nextWorkspace()
        return
      }

      // ── Tab management ──
      if (!shift && !alt && (key === 't' || e.code === 'KeyT')) {
        consume()
        store.createTerminalForActiveWorkspace()
        return
      }
      if (shift && !alt && e.code === 'KeyN') {
        consume()
        store.createTerminalForActiveWorkspace()
        return
      }
      if (!shift && !alt && (key === 'w' || e.code === 'KeyW')) {
        consume()
        store.closeActiveTab()
        return
      }
      if (shift && !alt && e.code === 'KeyW') {
        consume()
        store.closeAllWorkspaceTabs()
        return
      }
      if (shift && !alt && e.key === ']') {
        consume()
        store.nextTab()
        return
      }
      if (shift && !alt && e.key === '[') {
        consume()
        store.prevTab()
        return
      }

      // ── Panels ──
      // Ctrl+B — toggle sidebar (left)
      if (!shift && !alt && (key === 'b' || e.code === 'KeyB')) {
        consume()
        store.toggleSidebar()
        return
      }
      // Ctrl+Alt+B — toggle right panel
      if (!shift && alt && e.code === 'KeyB') {
        consume()
        store.toggleRightPanel()
        return
      }
      // Ctrl+Shift+E — files panel (open if closed)
      if (shift && !alt && e.code === 'KeyE') {
        consume()
        store.setRightPanelMode('files')
        if (!store.rightPanelOpen) store.toggleRightPanel()
        return
      }
      // Ctrl+Shift+G — changes panel (open if closed)
      if (shift && !alt && e.code === 'KeyG') {
        consume()
        store.setRightPanelMode('changes')
        if (!store.rightPanelOpen) store.toggleRightPanel()
        return
      }

      // ── Focus ──
      // Ctrl+J — focus terminal (or create one)
      if (!shift && !alt && (key === 'j' || e.code === 'KeyJ')) {
        consume()
        store.focusOrCreateTerminal()
        return
      }

      // ── Font size: Ctrl+= / Ctrl+- / Ctrl+0 ──
      if (!shift && !alt && (e.key === '=' || e.key === '-' || e.key === '0')) {
        consume()
        const tab = store.tabs.find((t) => t.id === store.activeTabId)
        const isTerminal = tab?.type === 'terminal'
        const key = isTerminal ? 'terminalFontSize' : 'editorFontSize'
        if (e.key === '0') {
          store.updateSettings({ terminalFontSize: 14, editorFontSize: 13 })
        } else {
          const current = store.settings[key]
          const next = Math.max(8, Math.min(32, current + (e.key === '=' ? 1 : -1)))
          store.updateSettings({ [key]: next })
        }
        return
      }

      // ── Settings ──
      // Ctrl+, — toggle settings
      if (!shift && !alt && key === ',') {
        consume()
        store.toggleSettings()
        return
      }

      // ── Workspace creation ──
      // Ctrl+N — new workspace dialog
      if (!shift && !alt && (key === 'n' || e.code === 'KeyN')) {
        consume()
        const project = store.activeProject()
        if (project) {
          store.openWorkspaceDialog(project.id)
        } else if (store.projects.length === 1) {
          store.openWorkspaceDialog(store.projects[0].id)
        }
        return
      }
    }

    // Capture phase: runs before ghostty-web's stopPropagation() on the terminal element
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Image paste: ghostty-web ignores clipboard images, so intercept and save to temp file
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement
      if (!target?.closest?.('[class*="terminalInner"]')) return
      if (!e.clipboardData) return

      const hasImage = Array.from(e.clipboardData.items).some(
        (item) => item.type.startsWith('image/')
      )
      if (!hasImage) return

      e.preventDefault()
      e.stopPropagation()

      const filePath = await window.api.clipboard.saveImage()
      if (!filePath) return

      const s = useAppStore.getState()
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (tab?.type === 'terminal') {
        window.api.pty.write(tab.ptyId, `\x1b[200~${filePath}\x1b[201~`)
      }
    }

    document.addEventListener('paste', handlePaste, true)
    return () => document.removeEventListener('paste', handlePaste, true)
  }, [])
}
