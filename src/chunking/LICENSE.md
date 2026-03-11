This software uses parts of the concepts discovered and created by the team behind Chonkie.

We couldn't use their NPM package as by default it uses the huggingface transformers library
for tokenization, which is 300+ mb in size and also installes the xenova runtimes for node and
web, which are each 200mb+ leading to a total package size of 1GB+ which was unacceptable for 
CI/CD pipelines where we had to prepackage and deliver the full dist to an environment without
internet access.

The way around this was to copy the main chunking algorithms from Chonkie (sentence and recursive) and
plugin our own tokenizer (using tiktoken) as an alternative.

Update 09.03.2026:
We created a completely new propietary version for markdown chunking from scratch in markdown.ts 
as existing libraries did not deliver what we needed (clean breakpoints, page metadata, handling 
multi page tables and more).

-------

MIT License

Copyright (c) 2025 Chonkie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.