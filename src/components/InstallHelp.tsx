import { useState } from 'react'
import Modal from './Modal'

type Platform = 'android' | 'ios' | 'chrome' | 'edge' | 'safari' | 'desktop'

function getPlatform(): Platform {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Edg\//i.test(ua)) return 'edge'
  if (/Chrome\//i.test(ua)) return 'chrome'
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'safari'
  return 'desktop'
}

function InstallInstructions({ platform }: { platform: Platform }) {
  switch (platform) {
    case 'android':
      return (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <ol className="list-decimal list-inside space-y-2">
            <li>Open this site in Chrome</li>
            <li>Tap the menu button (three dots) in the top right corner</li>
            <li>Tap "Add to Home screen" or "Install app"</li>
            <li>Customize the name if desired, then tap "Add"</li>
            <li>The app icon will appear in your App Drawer</li>
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
      )

    case 'ios':
      return (
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
      )

    case 'chrome':
      return (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <ol className="list-decimal list-inside space-y-2">
            <li>Click the install icon (monitor with down arrow) in the address bar, or click ⋮ menu &gt; "Cast, Save, and Share" &gt; "Install page as app..."</li>
            <li>Click "Install" in the dialog</li>
            <li>The app will open in its own window and be available from your desktop</li>
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
      )

    case 'edge':
      return (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <ol className="list-decimal list-inside space-y-2">
            <li>Click the "App available" icon in the address bar, or click ⋯ menu &gt; Apps &gt; "Install this site as an app"</li>
            <li>Click "Install" in the dialog</li>
            <li>The app will open in its own window and integrate with the taskbar/Start menu</li>
          </ol>
          <p className="pt-2">
            <a
              href="https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/ux"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Detailed instructions (Microsoft Learn)
            </a>
          </p>
        </div>
      )

    case 'safari':
      return (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <ol className="list-decimal list-inside space-y-2">
            <li>In Safari, go to File &gt; Add to Dock (requires macOS Sonoma 14 or later)</li>
            <li>Or click the Share button in the toolbar and select "Add to Dock"</li>
            <li>Name the app and click Add</li>
            <li>The app will be available from the Dock and Spotlight</li>
          </ol>
          <p className="pt-2">
            <a
              href="https://support.apple.com/en-mide/104996"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Detailed instructions (Apple Support)
            </a>
          </p>
        </div>
      )

    case 'desktop':
      return (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <p>
            PWA installation is available in the following browsers:
          </p>
          <ul className="list-disc list-inside space-y-2">
            <li>
              <a
                href="https://support.google.com/chrome/answer/9658361"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Google Chrome
              </a>
              {' '}— Look for the install icon in the address bar or use the ⋮ menu
            </li>
            <li>
              <a
                href="https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/ux"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Microsoft Edge
              </a>
              {' '}— Look for the "App available" icon or use the ⋯ menu &gt; Apps
            </li>
            <li>
              <a
                href="https://support.apple.com/en-mide/104996"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Safari on Mac
              </a>
              {' '}— Use File &gt; Add to Dock (macOS Sonoma 14+)
            </li>
          </ul>
        </div>
      )
  }
}

export default function InstallHelp() {
  const [showModal, setShowModal] = useState(false)
  const platform = getPlatform()

  if (window.location.hostname === 'localhost') return null;

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
        <InstallInstructions platform={platform} />
      </Modal>
    </>
  )
}
