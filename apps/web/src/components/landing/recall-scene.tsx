"use client";

// The landing page's 3D picture of the product, in one loop:
// 32 orders -> a scan finds the 23 from the recalled batch -> 5 unclear records
// are held for a person -> 20 refunds flow through PayPal -> each customer
// turns green only when PayPal confirms. The numbers are the demo case's.

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export type Phase = 0 | 1 | 2 | 3 | 4;

const LOOP = 13; // seconds
const COLS = 8;
const ROWS = 4;
const ORDERS = COLS * ROWS;

// Which orders are in the recalled batch, which are proven, which are held. Fixed, so the picture always tells the same story.
const AFFECTED = [0, 2, 3, 5, 6, 7, 8, 9, 11, 12, 14, 15, 17, 18, 19, 21, 22, 24, 26, 27, 28, 30, 31];
const HELD = new Set([9, 19, 28, 4, 25]); // 3 in the batch but unproven, 2 records that do not agree
const PROVEN = AFFECTED.filter((i) => !HELD.has(i)); // 20

const C = {
  idle: new THREE.Color("#64748b"),
  affected: new THREE.Color("#f59e0b"),
  held: new THREE.Color("#fb923c"),
  paid: new THREE.Color("#10b981"),
  hub: new THREE.Color("#3b82f6"),
  white: new THREE.Color("#ffffff"),
  black: new THREE.Color("#000000"),
};

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

function phaseAt(t: number): Phase {
  if (t < 1.4) return 0;
  if (t < 4.2) return 1;
  if (t < 5.6) return 2;
  if (t < 9.6) return 3;
  return 4;
}

function orderPosition(i: number): THREE.Vector3 {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return new THREE.Vector3(-4.15 + col * 0.38, 0.9 - row * 0.6, Math.sin(col * 0.8) * 0.15);
}

function customerPosition(k: number): THREE.Vector3 {
  // An arc of 20 on the right.
  const a = -0.95 + (k / (PROVEN.length - 1)) * 1.9;
  return new THREE.Vector3(2.45 + Math.cos(a) * 1.3, Math.sin(a) * 1.9, Math.sin(a * 2) * 0.3);
}

const HUB = new THREE.Vector3(0, 0, 0);

function Scene({ onPhase, still }: { onPhase?: (p: Phase) => void; still: boolean }) {
  const group = useRef<THREE.Group>(null);
  const orders = useRef<(THREE.Mesh | null)[]>([]);
  const customers = useRef<(THREE.Mesh | null)[]>([]);
  const packets = useRef<(THREE.Mesh | null)[]>([]);
  const scan = useRef<THREE.Mesh>(null);
  const hub = useRef<THREE.Group>(null);
  const hubCore = useRef<THREE.MeshStandardMaterial>(null);
  const lastPhase = useRef<Phase | -1>(-1);

  const orderPos = useMemo(() => Array.from({ length: ORDERS }, (_, i) => orderPosition(i)), []);
  const customerPos = useMemo(() => PROVEN.map((_, k) => customerPosition(k)), []);
  // Two curved legs per refund: order -> PayPal, PayPal -> customer.
  const legs = useMemo(
    () =>
      PROVEN.map((i, k) => {
        const from = orderPos[i]!;
        const to = customerPos[k]!;
        return [
          new THREE.QuadraticBezierCurve3(from, new THREE.Vector3((from.x + HUB.x) / 2, from.y * 0.4 + 0.9, 0.6), HUB),
          new THREE.QuadraticBezierCurve3(HUB, new THREE.Vector3((HUB.x + to.x) / 2, to.y * 0.6 - 0.5, 0.6), to),
        ] as const;
      }),
    [orderPos, customerPos],
  );
  const affected = useMemo(() => new Set(AFFECTED), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  const point = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const t = still ? 10.5 : state.clock.elapsedTime % LOOP;
    const phase = phaseAt(t);
    if (phase !== lastPhase.current) {
      lastPhase.current = phase;
      onPhase?.(phase);
    }
    const fadeOut = 1 - smooth(LOOP - 0.8, LOOP, t);
    // A still picture is drawn once, so it jumps straight to its colours.
    const ease = still ? 1 : 0.15;

    // Gentle follow of the pointer.
    if (group.current) {
      const p = still ? { x: 0, y: 0 } : state.pointer;
      const k = still ? 1 : 0.05;
      group.current.rotation.y += (p.x * 0.22 - 0.12 - group.current.rotation.y) * k;
      group.current.rotation.x += (-p.y * 0.12 + 0.05 - group.current.rotation.x) * k;
    }

    // The scan line moves across the orders.
    const scanX = -4.4 + smooth(1.4, 4.0, t) * 3.1;
    if (scan.current) {
      scan.current.position.x = scanX;
      (scan.current.material as THREE.MeshBasicMaterial).opacity = (t > 1.4 && t < 4.2 ? 0.55 : 0) * fadeOut;
    }

    for (let i = 0; i < ORDERS; i++) {
      const mesh = orders.current[i];
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const pos = orderPos[i]!;
      const found = scanX > pos.x && t > 1.4;
      let target = C.idle;
      let glow = 0;
      if (found && affected.has(i)) {
        target = C.affected;
        glow = 0.35;
      }
      if (HELD.has(i) && t > 4.2) {
        target = C.held;
        glow = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 6));
      }
      const k = PROVEN.indexOf(i);
      if (k >= 0 && t > 5.6 + k * 0.12) {
        target = C.paid;
        glow = 0.15;
      }
      if (fadeOut < 1) {
        tmp.copy(C.idle).lerp(target, fadeOut);
        target = tmp;
        glow *= fadeOut;
      }
      mat.color.lerp(target, ease);
      mat.emissive.copy(mat.color).multiplyScalar(glow);
      mesh.position.y = pos.y + (still ? 0 : Math.sin(state.clock.elapsedTime * 1.2 + i * 0.7) * 0.03);
      const s = HELD.has(i) && t > 4.2 && t < LOOP - 0.8 ? 1.12 : 1;
      mesh.scale.setScalar(mesh.scale.x + (s - mesh.scale.x) * ease);
    }

    // PayPal in the middle: brighter while payments flow.
    if (hub.current) hub.current.rotation.y += still ? 0 : 0.006;
    if (hubCore.current) hubCore.current.emissiveIntensity = 0.5 + 0.9 * smooth(5.0, 5.8, t) * (1 - smooth(9.4, 10.2, t)) * fadeOut;

    PROVEN.forEach((_, k) => {
      const packet = packets.current[k];
      const customer = customers.current[k];
      const start = 5.6 + k * 0.12;
      const u = Math.min(1, Math.max(0, (t - start) / 2.4));
      if (packet) {
        const visible = u > 0 && u < 1 && fadeOut > 0.99;
        packet.visible = visible;
        if (visible) {
          const [a, b] = legs[k]!;
          if (u < 0.5) a.getPoint(smooth(0, 1, u * 2), point);
          else b.getPoint(smooth(0, 1, (u - 0.5) * 2), point);
          packet.position.copy(point);
        }
      }
      if (customer) {
        const mat = customer.material as THREE.MeshStandardMaterial;
        const confirmed = u >= 1 && fadeOut > 0;
        mat.color.lerp(confirmed ? C.paid : C.idle, still ? 1 : 0.12);
        mat.emissive.copy(mat.color).multiplyScalar(confirmed ? 0.45 * fadeOut : 0);
        const s = confirmed ? 1.25 : 1;
        customer.scale.setScalar(customer.scale.x + (s - customer.scale.x) * (still ? 1 : 0.12));
      }
    });
  });

  return (
    <group ref={group}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 6]} intensity={1.6} />
      <pointLight position={[0, 0, 2]} intensity={6} distance={6} color={C.hub} />

      {orderPos.map((p, i) => (
        <mesh
          key={i}
          ref={(m) => {
            orders.current[i] = m;
          }}
          position={p}
        >
          <boxGeometry args={[0.28, 0.28, 0.28]} />
          <meshStandardMaterial color={C.idle} roughness={0.45} metalness={0.15} />
        </mesh>
      ))}

      <mesh ref={scan} position={[-4.4, 0, 0.3]}>
        <planeGeometry args={[0.05, 2.7]} />
        <meshBasicMaterial color={C.affected} transparent opacity={0} />
      </mesh>

      <group ref={hub}>
        <mesh>
          <icosahedronGeometry args={[0.62, 1]} />
          <meshStandardMaterial ref={hubCore} color={C.hub} emissive={C.hub} emissiveIntensity={0.5} roughness={0.3} metalness={0.4} flatShading />
        </mesh>
        <mesh rotation={[Math.PI / 2.3, 0, 0]}>
          <torusGeometry args={[1.0, 0.018, 8, 96]} />
          <meshBasicMaterial color={C.hub} transparent opacity={0.6} />
        </mesh>
        <mesh rotation={[Math.PI / 1.7, 0.5, 0]}>
          <torusGeometry args={[1.25, 0.01, 8, 96]} />
          <meshBasicMaterial color={C.hub} transparent opacity={0.35} />
        </mesh>
      </group>

      {customerPos.map((p, k) => (
        <mesh
          key={k}
          ref={(m) => {
            customers.current[k] = m;
          }}
          position={p}
        >
          <sphereGeometry args={[0.13, 20, 20]} />
          <meshStandardMaterial color={C.idle} roughness={0.35} />
        </mesh>
      ))}

      {PROVEN.map((_, k) => (
        <mesh
          key={k}
          ref={(m) => {
            packets.current[k] = m;
          }}
          visible={false}
        >
          <sphereGeometry args={[0.06, 12, 12]} />
          <meshBasicMaterial color={C.paid} />
        </mesh>
      ))}
    </group>
  );
}

export default function RecallScene({ onPhase, still = false, paused = false }: { onPhase?: (p: Phase) => void; still?: boolean; paused?: boolean }) {
  return (
    <Canvas
      camera={{ position: [0, 0, 9.1], fov: 42 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      frameloop={still ? "demand" : paused ? "never" : "always"}
      aria-hidden
    >
      <Scene onPhase={onPhase} still={still} />
    </Canvas>
  );
}
