import { useState } from 'react'
import Modal from './Modal'

function getPlatform(): 'android' | 'ios' | null {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  return null
}

export default function InstallHelp() {
  const [showModal, setShowModal] = useState(false)
  const platform = getPlatform()

  if (!platform) return null

  // Hide install prompt if already running as installed PWA
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true;
  if (isStandalone) return null;

  return (
    <>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault()
          setShowModal(true)
        }}
        className="text-blue-600 dark:text-blue-400 hover:underline font-semibold"
      >
        Install
      </a>
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Install as App" size="md">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Skylimit is a Progressive Web App that can be installed directly from the browser:
        </p>
        {platform === 'android' ? (
          <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
            <ol className="list-decimal list-inside space-y-2">
              <li>Open this site in Chrome</li>
              <li>Tap the menu button (three dots) in the top right corner</li>
              <li>Tap "Add to Home screen" or "Install app"</li>
              <li>Customize the name if desired, then tap "Add"</li>
              <li>The app icon will appear on your home screen</li>
            </ol>
            <p className="pt-2">
              <a
                href="https://support.google.com/chrome/answer/9658361"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Detailed instructions (Google Support)
              </a>
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
            <ol className="list-decimal list-inside space-y-2">
              <li>Open this site in Safari</li>
              <li>Tap the Share button (square with up arrow) at the bottom of the screen</li>
              <li>Scroll down and tap "Add to Home Screen"</li>
              <li>Customize the name if desired, then tap "Add" in the top right</li>
              <li>The app icon will appear on your home screen</li>
            </ol>
            <p className="text-gray-500 dark:text-gray-400 pt-1">
              On iOS 17+, you can also install from Chrome or Edge using the Share button in the URL bar.
            </p>
            <p className="pt-1">
              <a
                href="https://support.apple.com/en-us/104996"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Detailed instructions (Apple Support)
              </a>
            </p>
          </div>
        )}
      </Modal>
    </>
  )
}
