import { useEffect, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'
import coseBilkent from 'cytoscape-cose-bilkent'
import NodePanel from './NodePanel.jsx'

cytoscape.use(dagre)
cytoscape.use(coseBilkent)

// Cytoscape colour map: entity_type → fill
const NODE_COLOR = {
  Decision:    '#3b82f6',
  Pattern:     '#22c55e',
  Constraint:  '#f59e0b',
  Runbook:     '#a855f7',
  Requirement: '#6b7280',
  unknown:     '#374151',
}

const EDGE_COLOR = {
  SUPERSEDES:     '#6b7280',
  CONFLICTS_WITH: '#ef4444',
  RELATES_TO:     '#4b5563',
  DEPENDS_ON:     '#e5e7eb',
}

/**
 * Cytoscape.js wrapper.
 * Re-initialises the graph when `elements` changes (domain switch).
 * Node click → NodePanel slide-in.
 */
export default function KnowledgeGraph({ elements }) {
  const containerRef  = useRef(null)
  const cyRef         = useRef(null)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    if (!containerRef.current || !elements) return

    // Destroy previous instance
    cyRef.current?.destroy()
    setSelected(null)

    const { nodes = [], edges = [] } = elements

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
            'color':             '#e5e7eb',
            'text-valign':       'bottom',
            'text-margin-y':     4,
            'border-width':      1,
            'border-color':      '#374151',
            'cursor':            'pointer',
          },
        },
        {
          selector: 'edge',
          style: {
            'line-color':         (ele) => EDGE_COLOR[ele.data('type')] ?? '#4b5563',
            'target-arrow-color': (ele) => EDGE_COLOR[ele.data('type')] ?? '#4b5563',
            'target-arrow-shape': 'triangle',
            'curve-style':        'bezier',
            'width':              1,
            'line-style':         (ele) => ele.data('type') === 'SUPERSEDES' ? 'dashed' : 'solid',
            'opacity':            0.7,
          },
        },
        {
          selector: 'node:selected',
          style: { 'border-width': 2, 'border-color': '#60a5fa' },
        },
      ],
      layout: {
        name:        nodes.length > 30 ? 'cose-bilkent' : 'dagre',
        directed:    true,
        padding:     40,
        animate:     false,
        nodeDimensionsIncludeLabels: true,
      },
    })

    cyRef.current.on('tap', 'node', (evt) => setSelected(evt.target))
    cyRef.current.on('tap', (evt) => { if (evt.target === cyRef.current) setSelected(null) })

    return () => { cyRef.current?.destroy(); cyRef.current = null }
  }, [elements])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full bg-gray-950 rounded-lg" />
      <NodePanel node={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
