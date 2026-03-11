# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import copy_metadata, collect_data_files
import os

block_cipher = None

# Collect package metadata for packages that need it
datas = []
datas += copy_metadata('docling')
datas += copy_metadata('docling-core')
datas += copy_metadata('docling-parse')
datas += copy_metadata('docling-ibm-models')
datas += copy_metadata('transformers')
datas += copy_metadata('torch')
datas += copy_metadata('tokenizers')
datas += copy_metadata('huggingface-hub')
datas += copy_metadata('pydantic')
datas += copy_metadata('pydantic-core')

# Collect data files from docling packages
datas += collect_data_files('docling_parse')
datas += collect_data_files('docling')
datas += collect_data_files('docling_core')
datas += collect_data_files('docling_ibm_models')
datas += collect_data_files('transformers')

# Collect all data files from docling and transformers packages
a = Analysis(
    ['pdf_processor.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[
        'docling',
        'docling.document_converter',
        'docling.chunking',
        'docling.models',
        'docling.models.plugins',
        'docling.models.plugins.defaults',
        'docling.backend',
        'docling.backend.docling_parse_backend',
        'docling.backend.asciidoc_backend',
        'docling.backend.html_backend',
        'docling.backend.md_backend',
        'docling.backend.msexcel_backend',
        'docling.backend.mspowerpoint_backend',
        'docling.backend.msword_backend',
        'docling.datamodel',
        'docling.datamodel.document',
        'docling_core',
        'docling_core.transforms.chunker',
        'docling_core.transforms.chunker.tokenizer',
        'docling_core.transforms.chunker.tokenizer.huggingface',
        'transformers',
        'transformers.models',
        'transformers.models.auto',
        'torch',
        'numpy',
        'PIL',
        'pdfplumber',
        'pypdf',
        'pikepdf',
        'lxml',
        'bs4',
        'tiktoken',
        'tokenizers',
        'sentencepiece',
        'safetensors',
        'huggingface_hub',
        'tqdm',
        'regex',
        'requests',
        'urllib3',
        'certifi',
        'charset_normalizer',
        'idna',
        'packaging',
        'filelock',
        'pyyaml',
        'jinja2',
        'markupsafe',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='pdf_processor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
