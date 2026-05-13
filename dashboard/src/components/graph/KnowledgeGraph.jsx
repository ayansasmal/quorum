import { useEffect, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'
import coseBilkent from 'cytoscape-cose-bilkent'
import NodePanel from './NodePanel.jsx'
import { useTheme } from '../../context/ThemeContext.jsx'

cytoscape.use(dagre)
cytoscape.use(coseBilkent)

const NODE_COLOR = {
  Decision:    '#3b82f6',
  Pattern:     '#22c55e',
  Constraint:  '#f59e0b',
  Runbook:     '#a855f7',
  Requirement: '#6b7280',
  unknown:     '#374151',
}

/**
 * Returns Cytoscape style tokens that vary between light and dark themes.
 * Cytoscape draws to a canvas — it never reads CSS, so theme colours must
 * be passed as JS values into the style array.
 *
 * @param {boolean} isDark
 */
function themeTokens(isDark) {
  return {
    labelColor:        isDark ? '#e5e7eb' : '#1f2937',
    nodeBorder:        isDark ? '#374151' : '#d1d5db',
    hubBg:             isDark ? '#0f172a' : '#eff6ff',
    hubBorder:         isDark ? '#38bdf8' : '#0284c7',
    hubLabel:          isDark ? '#38bdf8' : '#0284c7',
    edgeDefault:       isDark ? '#6b7280' : '#334155',   // slate-700 in light
    edgeSupersede:     isDark ? '#9ca3af' : '#475569',   // slate-600 in light
    // BELONGS_TO edges are the dominant structural edges (leaf → hub).
    edgeBelongsTo:     isDark ? '#4b5563' : '#64748b',   // slate-500 in light
    opacityDefault:    1,
    opacityBelongsTo:  isDark ? 0.20 : 0.30,
  }
}

/**
 * Cytoscape.js wrapper.
 * Re-initialises the graph when `elements` or `theme` changes.
 * Node click → NodePanel slide-in.
 *
 * @param {{ elements: { nodes: object[], edges: object[] } }} props
 */
export default function KnowledgeGraph({ elements }) {
  const containerRef  = useRef(null)
  const cyRef         = useRef(null)
  const [selected, setSelected] = useState(null)
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  useEffect(() => {
    if (!containerRef.current || !elements) return

    // Destroy previous instance
    cyRef.current?.destroy()
    setSelected(null)

    const { nodes = [], edges = [] } = elements
    const t = themeTokens(isDark)

    const EDGE_COLOR = {
      BELONGS_TO:     isDark ? '#60a5fa' : '#3b82f6',  // blue
      RELATES_TO:     isDark ? '#4ade80' : '#16a34a',  // green
      SUPERSEDES:     isDark ? '#fbbf24' : '#d97706',  // amber
      CONFLICTS_WITH: isDark ? '#f87171' : '#dc2626',  // red
      DEPENDS_ON:     t.edgeDefault,
    }

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements: [...nodes, ...edges],
      style: [
        {
          selector: 'node',
          style: {
            'background-color':  (ele) => NODE_COLOR[ele.data('entity_type')] ?? NODE_COLOR.unknown,
            'width':             (ele) => Math.max(20, (ele.data('confidence') ?? 0.5) * 50),
            'height':            (ele) => Math.max(20, (ele.data('confidence') ?? 0.5) * 50),
            'label':             (ele) => ele.data('key'),
            'font-size':         10,
            'color':             t.labelColor,
            'text-valign':       'bottom',
            'text-margin-y':     4,
            'border-width':      1,
            'border-color':      t.nodeBorder,
            'cursor':            'pointer',
          },
        },
        {
          selector: 'node[node_type = "hub"]',
          style: {
            'background-color': t.hubBg,
            'border-width':     3,
            'border-color':     t.hubBorder,
            'width':            70,
            'height':           70,
            'label':            (ele) => ele.data('label'),
            'font-size':        13,
            'font-weight':      'bold',
            'color':            t.hubLabel,
            'text-valign':      'center',
            'text-halign':      'center',
          },
        },
        {
          selector: 'edge',
          style: {
            'line-color':         (ele) => EDGE_COLOR[ele.data('type')] ?? t.edgeDefault,
            'target-arrow-color': (ele) => EDGE_COLOR[ele.data('type')] ?? t.edgeDefault,
            'target-arrow-shape': 'triangle',
            'arrow-scale':        1,
            'curve-style':        'bezier',
            'width':              1,
            // Primary (BELONGS_TO hub spokes): solid blue. Secondary (RELATES_TO, SUPERSEDES): dashed.
            'line-style':         (ele) => ele.data('type') === 'BELONGS_TO' ? 'solid' : 'dashed',
            'opacity':            (ele) => ele.data('type') === 'RELATES_TO' ? t.opacityBelongsTo : t.opacityDefault,
          },
        },
        {
          selector: 'node:selected',
          style: { 'border-width': 2, 'border-color': '#60a5fa' },
        },
      ],
      layout: {
        name:    'cose-bilkent',
        animate: false,
        padding: 40,
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: 100,
        nodeRepulsion: 8000,
        gravity: 0.4,
      },
    })

    cyRef.current.on('tap', 'node', (evt) => setSelected(evt.target))
    cyRef.current.on('tap', (evt) => { if (evt.target === cyRef.current) setSelected(null) })

    return () => { cyRef.current?.destroy(); cyRef.current = null }
  }, [elements, isDark])

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className="w-full h-full rounded-lg bg-white dark:bg-gray-950"
      />
      <NodePanel node={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
