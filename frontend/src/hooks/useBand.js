import { useEffect, useRef } from 'react';
import { useRadio } from '../contexts/RadioContext';

/**
 * Put this view's list under the dial for as long as the view is on screen.
 *
 * Pass null while the list is still loading; the engine keeps the previous
 * band until a real one arrives, so the transport is never dead between a
 * view mounting and its data landing.
 */
export function useBand(band) {
  const { registerBand } = useRadio();
  const ownerRef = useRef(null);
  if (!ownerRef.current) ownerRef.current = Symbol('band');

  useEffect(() => {
    const owner = ownerRef.current;
    registerBand(owner, band);
    return () => registerBand(owner, null);
  }, [band, registerBand]);
}

export default useBand;
