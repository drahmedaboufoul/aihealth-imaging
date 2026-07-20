/*
 * ToothPicker — click a tooth on the scan, label it with its FDI number.
 *
 * UX:
 *   - Tool active in IOS viewer toolbar (when its parent activeTool is 'tooth-label').
 *   - Click anywhere on the mesh → raycast hit point becomes a "tooth marker"
 *     anchor. A small floating input pops up at the cursor asking for the FDI
 *     number (or pick from a 32-tooth arch picker).
 *   - Submit → label persists in store as an annotation (type: 'tooth') and
 *     renders as a small numbered pill at the picked point.
 *
 * FDI numbering (ISO 3950):
 *   - First digit: 1 = upper right, 2 = upper left, 3 = lower left, 4 = lower right
 *   - Second digit: 1-8 from central incisor → 3rd molar
 *   - Example: 11 = upper right central incisor, 36 = lower left 1st molar
 *
 * We persist FDI tooth labels alongside other annotations in the store so they
 * survive across sessions (when persistence is wired) and show up in reports.
 *
 * Detection: when the picked point's Y coordinate is above the mesh midline,
 * we auto-suggest upper arch (1x/2x); below midline → lower arch (3x/4x).
 * X >= 0 (model-right side, viewer-left) → right quadrant; X < 0 → left.
 * This gives a smart default for the FDI input.
 */

import { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { toast } from 'sonner';
import { useIOSViewerStore } from './store/iosViewerStore';

interface Props {
  active: boolean;
}

const FDI_TOOTH_NAMES: Record<string, string> = {
  // Upper right (Q1)
  '11': 'UR central incisor',
  '12': 'UR lateral incisor',
  '13': 'UR canine',
  '14': 'UR 1st premolar',
  '15': 'UR 2nd premolar',
  '16': 'UR 1st molar',
  '17': 'UR 2nd molar',
  '18': 'UR 3rd molar',
  // Upper left (Q2)
  '21': 'UL central incisor',
  '22': 'UL lateral incisor',
  '23': 'UL canine',
  '24': 'UL 1st premolar',
  '25': 'UL 2nd premolar',
  '26': 'UL 1st molar',
  '27': 'UL 2nd molar',
  '28': 'UL 3rd molar',
  // Lower left (Q3)
  '31': 'LL central incisor',
  '32': 'LL lateral incisor',
  '33': 'LL canine',
  '34': 'LL 1st premolar',
  '35': 'LL 2nd premolar',
  '36': 'LL 1st molar',
  '37': 'LL 2nd molar',
  '38': 'LL 3rd molar',
  // Lower right (Q4)
  '41': 'LR central incisor',
  '42': 'LR lateral incisor',
  '43': 'LR canine',
  '44': 'LR 1st premolar',
  '45': 'LR 2nd premolar',
  '46': 'LR 1st molar',
  '47': 'LR 2nd molar',
  '48': 'LR 3rd molar',
};

export default function ToothPicker({ active }: Props) {
  const { camera, scene, gl } = useThree();
  const addAnnotation = useIOSViewerStore((s: any) => s.addAnnotation);
  const annotations   = useIOSViewerStore((s: any) => s.annotations);

  // Pending pick: { pos: [x,y,z], suggestion: string }
  const [pending, setPending] = useState<{ pos: [number, number, number]; suggestion: string } | null>(null);

  useEffect(() => {
    if (!active) {
      setPending(null);
      return;
    }
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const canvas = gl.domElement;

    const onClick = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const tgt = ev.target as HTMLElement;
      if (tgt && tgt !== canvas && tgt.tagName !== 'CANVAS') return;

      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);

      const meshes: THREE.Mesh[] = [];
      scene.traverse((o: any) => {
        if (o.isMesh && o.geometry && o.visible) meshes.push(o);
      });
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return;

      const hit = hits[0];
      const p = hit.point;
      // Smart-suggest FDI quadrant from the picked mesh's role + position.
      // Compute the mesh's bounding box to get midline X (the dental
      // midline runs through X≈0 for PCA-oriented scans).
      const role = (hit.object as any)?.userData?.role;
      const isUpper = role === 'maxilla';
      const isLower = role === 'mandible';
      const xSign = p.x >= 0 ? 'R' : 'L';
      // FDI quadrant: UR=1, UL=2, LL=3, LR=4
      let firstDigit = '?';
      if (isUpper) firstDigit = xSign === 'R' ? '1' : '2';
      else if (isLower) firstDigit = xSign === 'L' ? '3' : '4';
      // Default to first molar if no smart guess
      const suggestion = firstDigit === '?' ? '' : `${firstDigit}6`;

      setPending({ pos: [p.x, p.y, p.z], suggestion });
    };

    canvas.addEventListener('pointerdown', onClick);
    return () => canvas.removeEventListener('pointerdown', onClick);
  }, [active, camera, scene, gl]);

  const handleConfirm = (fdi: string) => {
    if (!pending) return;
    if (!/^[1-8][1-8]$/.test(fdi)) {
      toast.warning(`"${fdi}" isn't a valid FDI tooth number. Use 2 digits, e.g. 11, 36, 48.`);
      return;
    }
    addAnnotation({
      type: 'tooth',
      position: pending.pos,
      label: fdi,
      description: FDI_TOOTH_NAMES[fdi] || '',
      categoryId: 'tooth-label',
    });
    setPending(null);
  };

  return (
    <>
      {/* Persisted FDI labels */}
      {(annotations || []).filter((a: any) => a.type === 'tooth').map((a: any) => (
        <ToothLabel key={a.id} position={a.position} label={a.label} description={a.description} />
      ))}
      {/* Inline picker UI for the pending placement */}
      {pending && (
        <Html position={pending.pos} center distanceFactor={10}>
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              background: 'white', border: '1px solid #d4d4d8', borderRadius: 6,
              padding: '6px 8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              fontFamily: 'Inter, system-ui, sans-serif', minWidth: 180,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
              FDI number
            </div>
            <ToothInput suggestion={pending.suggestion} onConfirm={handleConfirm} onCancel={() => setPending(null)} />
          </div>
        </Html>
      )}
    </>
  );
}

function ToothInput({
  suggestion,
  onConfirm,
  onCancel,
}: {
  suggestion: string;
  onConfirm: (fdi: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(suggestion);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <input
        ref={inputRef}
        value={val}
        maxLength={2}
        onChange={(e) => setVal(e.target.value.replace(/[^1-8]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm(val);
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="e.g. 11"
        style={{
          width: 60, padding: '4px 6px', fontSize: 14, fontFamily: 'monospace',
          border: '1px solid #d4d4d8', borderRadius: 4,
        }}
      />
      <button
        onClick={() => onConfirm(val)}
        disabled={!/^[1-8][1-8]$/.test(val)}
        style={{
          padding: '4px 10px', fontSize: 11, fontWeight: 600,
          background: '#2563eb', color: 'white', border: 'none', borderRadius: 4,
          cursor: /^[1-8][1-8]$/.test(val) ? 'pointer' : 'not-allowed',
          opacity: /^[1-8][1-8]$/.test(val) ? 1 : 0.5,
        }}
      >
        Tag
      </button>
      <button
        onClick={onCancel}
        style={{
          padding: '4px 8px', fontSize: 11, color: '#71717a',
          background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        ✕
      </button>
    </div>
  );
}

function ToothLabel({
  position,
  label,
  description,
}: {
  position: [number, number, number];
  label: string;
  description?: string;
}) {
  return (
    <Html position={position} center distanceFactor={12}>
      <div
        title={description || ''}
        style={{
          background: '#1f2937', color: '#fbbf24',
          padding: '2px 8px', borderRadius: 999,
          fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
          border: '2px solid #fbbf24',
          boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
          pointerEvents: 'none',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </Html>
  );
}
