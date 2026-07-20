import { useQuery } from '@tanstack/react-query';
import { api, type Alternative, type ExerciseDetail } from '../api';
import { FormFig } from '../formfig';
import { MuscleMap } from '../musclemap';
import { Back, Chip, Loading, Shell, Title, useApp } from '../ui';

function Dots({ n }: { n: number }) {
  return (
    <span style={{ letterSpacing: 2, color: 'var(--volt)', fontSize: 11 }}>
      {'●'.repeat(n)}<i style={{ color: 'var(--dim)', fontStyle: 'normal' }}>{'○'.repeat(3 - n)}</i>
    </span>
  );
}

export function LearnScreen() {
  const { learnSlug, learnFrom, go } = useApp();
  const q = useQuery<ExerciseDetail>({
    queryKey: ['exercise', learnSlug],
    queryFn: () => api('/api/exercises/' + learnSlug),
    staleTime: Infinity,
  });
  const altsQ = useQuery<Alternative[]>({
    queryKey: ['alts', learnSlug],
    queryFn: () => api(`/api/exercises/${learnSlug}/alternatives`),
    staleTime: 60_000,
  });
  const e = q.data;
  const back = () => go(learnFrom === 'log' ? 'log' : learnFrom === 'library' ? 'library'
    : learnFrom === 'day' ? 'day' : 'today');

  if (!e) return <Shell><Back label="Back" onClick={back} /><Loading /></Shell>;
  // stretches don't get "alternatives" — a lift is not a substitute for mobility work
  const alts = e.kind === 'mobility' ? [] : (altsQ.data || []).filter((a) => !a.excluded).slice(0, 6);

  return (
    <Shell>
      <Back label="Back" onClick={back} />
      <Title kick="Form guide">{e.name}</Title>
      {/* 1 — reference photos */}
      {e.media_url && e.media_tier === 'images' && (
        <div className="card" style={{ padding: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {e.media_url.split(',').map((src, i) => (
              <img key={src} src={src} alt={`${e.name} — ${i === 0 ? 'start' : 'end'} position`}
                style={{ width: '50%', minWidth: 0, borderRadius: 10, display: 'block' }} />
            ))}
          </div>
          <div className="sub" style={{ textAlign: 'center', margin: '6px 0 2px', fontSize: 11.5 }}>
            Start → end · free-exercise-db (public domain)
          </div>
        </div>
      )}
      {/* 2 — animated correct-form figure */}
      <FormFig slug={e.slug} name={e.name} cues={e.cues} />
      {/* 3 — explanation: why + how */}
      {e.benefit && (
        <div className="card">
          <div className="kick" style={{ fontSize: 11, marginBottom: 5 }}>Why it's in the library</div>
          <p style={{ fontSize: 14, lineHeight: 1.55 }}>{e.benefit}</p>
        </div>
      )}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13.5 }}>
        {e.cues.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 9 }}>
            <b style={{ color: 'var(--volt)' }}>{i + 1}</b><span>{c}</span>
          </div>
        ))}
        {e.dont && (
          <div style={{ display: 'flex', gap: 9, color: 'var(--mut)' }}>
            <b style={{ color: 'var(--volt-deep)' }}>✕</b><span>{e.dont}</span>
          </div>
        )}
      </div>
      {/* 4 — muscles worked */}
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 8 }}>Muscles worked</div>
        <MuscleMap primary={e.primary_muscles} secondary={e.secondary_muscles} />
        {e.primary_muscles.map((m) => <div key={m} className="mrow"><span>{m}</span><Dots n={3} /></div>)}
        {e.secondary_muscles.map((m) => <div key={m} className="mrow"><span>{m}</span><Dots n={1} /></div>)}
      </div>
      {/* 5 — good alternatives */}
      {alts.length > 0 && (
        <div>
          <div className="kick" style={{ fontSize: 11, margin: '4px 2px 2px' }}>Good alternatives</div>
          {alts.map((a) => (
            <button key={a.slug} className="lrow press"
              onClick={() => go('learn', { learnSlug: a.slug, learnFrom })}>
              <b>{a.name}</b><span className="rsub">{a.why}</span><span className="chev">›</span>
            </button>
          ))}
          <Chip>Filtered to your equipment and niggles — same list the mid-session swap uses</Chip>
        </div>
      )}
      <button className="ghost press" onClick={() =>
        go('coach', { chatContext: { kind: 'exercise', id: e.slug, label: e.name } })}>
        Ask the coach about {e.name.toLowerCase()}
      </button>
      {e.equipment.length > 0 && <Chip>Needs: {e.equipment.join(' · ')}</Chip>}
    </Shell>
  );
}
