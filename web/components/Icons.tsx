type Props = { size?: number }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const IconPlus = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconSend = ({ size = 20 }: Props) => (
  <svg {...base(size)}>
    <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
  </svg>
)

export const IconStop = ({ size = 16 }: Props) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

export const IconPaperclip = ({ size = 19 }: Props) => (
  <svg {...base(size)}>
    <path d="M21 11.5l-8.6 8.6a5 5 0 01-7-7l8.6-8.6a3.3 3.3 0 114.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9" />
  </svg>
)

export const IconMic = ({ size = 19 }: Props) => (
  <svg {...base(size)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0014 0M12 18v3" />
  </svg>
)

export const IconSettings = ({ size = 19 }: Props) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.11-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9v.09a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1z" />
  </svg>
)

export const IconLayers = ({ size = 19 }: Props) => (
  <svg {...base(size)}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </svg>
)

export const IconPanelLeft = ({ size = 19 }: Props) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9.5 4v16" />
  </svg>
)

export const IconClose = ({ size = 19 }: Props) => (
  <svg {...base(size)}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)

export const IconChevronRight = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M9 18l6-6-6-6" />
  </svg>
)

export const IconBack = ({ size = 20 }: Props) => (
  <svg {...base(size)}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
)

export const IconFolder = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
)

export const IconFile = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
)

export const IconBook = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" />
    <path d="M4 19a2 2 0 012-2h13" />
  </svg>
)

export const IconChat = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z" />
  </svg>
)

export const IconGrid = ({ size = 17 }: Props) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
  </svg>
)

export const IconList = ({ size = 17 }: Props) => (
  <svg {...base(size)}>
    <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
  </svg>
)

export const IconUsers = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M16 20v-1.5a4 4 0 00-4-4H6a4 4 0 00-4 4V20" />
    <circle cx="9" cy="7" r="3.4" />
    <path d="M22 20v-1.5a4 4 0 00-3-3.87M16 3.6a4 4 0 010 7.75" />
  </svg>
)

export const IconChart = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M3 20h18M7 20v-7M12 20V6M17 20v-4" />
  </svg>
)

export const IconRefresh = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M20 11a8 8 0 10-2.3 6.1M20 5v6h-6" />
  </svg>
)

export const IconTrash = ({ size = 17 }: Props) => (
  <svg {...base(size)}>
    <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
  </svg>
)

export const IconLink = ({ size = 17 }: Props) => (
  <svg {...base(size)}>
    <path d="M10 13a4 4 0 006 .5l2.5-2.5a4 4 0 00-5.7-5.7L11.5 6.6" />
    <path d="M14 11a4 4 0 00-6-.5L5.5 13a4 4 0 005.7 5.7l1.3-1.3" />
  </svg>
)

export const IconShare = ({ size = 17 }: Props) => (
  <svg {...base(size)}>
    <path d="M12 15V3M8.5 6.5L12 3l3.5 3.5" />
    <path d="M20 14v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5" />
  </svg>
)

export const IconUser = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0115 0" />
  </svg>
)

export const IconCopy = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
)

export const IconLogout = ({ size = 17 }: Props) => (
  <svg {...base(size)}>
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
)
