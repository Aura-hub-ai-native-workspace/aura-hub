"""Real artifact generation — DOCX, XLSX, PDF (S10).

Produces genuine binary file formats, not markdown rendered as a document.
All generation runs locally with no cloud service dependency.

Install optional dependencies:
    pip install aura-backend[artifacts]

Quick start:
    from aura.artifacts import ArtifactGenerator, ArtifactSpec, ArtifactType
    gen = ArtifactGenerator()
    spec = ArtifactSpec(
        artifact_type=ArtifactType.DOCX,
        title='Inspection Report',
        sections=[
            {'heading': 'Summary', 'body': 'Inspection passed.'},
            {'heading': 'Findings', 'rows': [['Item', 'Status'], ['Door', 'OK']]},
        ])
    result = gen.generate(spec, output_path='/tmp/report.docx')
"""

from .generator import ArtifactGenerator, ArtifactSpec, ArtifactType, ArtifactResult

__all__ = ["ArtifactGenerator", "ArtifactSpec", "ArtifactType", "ArtifactResult"]
