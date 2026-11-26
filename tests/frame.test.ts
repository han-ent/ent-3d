import { describe, expect, it } from 'vitest';
import { anatomicalPlaneName, ctDisplayOrient, ctEdgeLabels, displayedEdgeLabels, GIZMO_AXES, mapDisplayToRaw, mapRawToDisplay } from '../src/shared/frame';
import { framingSpanMm } from '../src/shared/view-pose';

describe('anatomical frame', () => {
  it('labels the gizmo Ant/Post/Sup/Inf/Lat/Med on the specimen axes', () => {
    const byId = Object.fromEntries(GIZMO_AXES.map((axis) => [axis.id, axis]));
    expect(byId.ant?.dir).toEqual([1, 0, 0]);
    expect(byId.inf?.dir).toEqual([0, 1, 0]);
    expect(byId.med?.dir).toEqual([0, 0, 1]);
    expect(byId.sup?.text).toBe('Sup');
    expect(byId.lat?.text).toBe('Lat');
  });

  it('frames a small structure at about a 10 mm scale and opens up for a large one', () => {
    const phone = framingSpanMm(4, 390, 420);
    expect(phone).toBeGreaterThanOrEqual((420 * 10) / 96);
    expect(phone).toBeGreaterThanOrEqual(8);
    const large = framingSpanMm(40, 390, 420);
    expect(large).toBeGreaterThanOrEqual(80 * 1.6);
  });

  it('renames the published CT folders to the anatomical plane', () => {
    expect(anatomicalPlaneName('axial')).toBe('sagittal');
    expect(anatomicalPlaneName('coronal')).toBe('axial');
    expect(anatomicalPlaneName('sagittal')).toBe('coronal');
    expect(ctEdgeLabels('axial')).toEqual({ left: 'Post', top: 'Inf', right: 'Ant', bottom: 'Sup' });
    expect(ctEdgeLabels('coronal').top).toBe('Med');
  });

  it('turns slices into radiological orientation for this right ear', () => {
    expect(displayedEdgeLabels('coronal')).toEqual({ left: 'Lat', top: 'Ant', right: 'Med', bottom: 'Post' });
    expect(displayedEdgeLabels('sagittal')).toEqual({ left: 'Lat', top: 'Sup', right: 'Med', bottom: 'Inf' });
    expect(displayedEdgeLabels('axial').top).toBe('Sup');
    const axial = ctDisplayOrient('coronal');
    const anteriorMedial = mapRawToDisplay(axial, 1, 0);
    expect(anteriorMedial.v).toBeCloseTo(0);
    expect(anteriorMedial.u).toBeCloseTo(1);
    const back = mapDisplayToRaw(axial, anteriorMedial.u, anteriorMedial.v);
    expect(back.u).toBeCloseTo(1);
    expect(back.v).toBeCloseTo(0);
    const coronal = ctDisplayOrient('sagittal');
    const superior = mapRawToDisplay(coronal, 0, 0.5);
    expect(superior.v).toBeLessThan(0.5);
  });
});
