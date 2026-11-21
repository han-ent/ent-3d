import { describe, expect, it } from 'vitest';
import { anatomicalPlaneName, ctEdgeLabels, GIZMO_AXES } from '../src/shared/frame';

describe('anatomical frame', () => {
  it('labels the gizmo Ant/Post/Sup/Inf/Lat/Med on the specimen axes', () => {
    const byId = Object.fromEntries(GIZMO_AXES.map((axis) => [axis.id, axis]));
    expect(byId.ant?.dir).toEqual([1, 0, 0]);
    expect(byId.inf?.dir).toEqual([0, 1, 0]);
    expect(byId.med?.dir).toEqual([0, 0, 1]);
    expect(byId.sup?.text).toBe('Sup');
    expect(byId.lat?.text).toBe('Lat');
  });

  it('renames the published CT folders to the anatomical plane', () => {
    expect(anatomicalPlaneName('axial')).toBe('sagittal');
    expect(anatomicalPlaneName('coronal')).toBe('axial');
    expect(anatomicalPlaneName('sagittal')).toBe('coronal');
    expect(ctEdgeLabels('axial')).toEqual({ left: 'Post', top: 'Inf', right: 'Ant', bottom: 'Sup' });
    expect(ctEdgeLabels('coronal').top).toBe('Med');
  });
});
