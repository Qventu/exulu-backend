Note: we used a lot of the Chonkie open source library, but couldn't use it as an npm package as
by default it uses the huggingface transformers library for tokenization, which is 300+ mb in size
and also installes the xenova runtimes for node and web, which are each 200mb+ leading to a total
package size of 1GB+ which was unacceptable for CI/CD pipelines.

The way around this was to copy the main chunking algorithms from Chonkie (sentence and recursive) and
plugin our own tokenizer (using tiktoken) as an alternative.

We should reach out to the chonkie team to check if they can implement this in the main library.