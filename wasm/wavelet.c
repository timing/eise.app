/* 
 * Wavelet sharpen GIMP plugin
 * 
 * wavelet.c
 * Copyright 2008 by Marco Rossini
 * 
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 2+
 * as published by the Free Software Foundation.
 */

#include <stdlib.h>
#include <stdio.h>
#include <math.h>

#define MAX2(x,y) ((x) > (y) ? (x) : (y))


/* code copied from UFRaw (which originates from dcraw) */
void
hat_transform (float *temp, float *base, int st, int size, int sc)
{
  int i;
  for (i = 0; i < sc; i++)
    temp[i] = 2 * base[st * i] + base[st * (sc - i)] + base[st * (i + sc)];
  for (; i + sc < size; i++)
    temp[i] = 2 * base[st * i] + base[st * (i - sc)] + base[st * (i + sc)];
  for (; i < size; i++)
    temp[i] = 2 * base[st * i] + base[st * (i - sc)]
      + base[st * (2 * size - 2 - (i + sc))];
}

/* actual sharpening algorithm */
void
wavelet_sharpen (float *imageData, unsigned int width,
		 unsigned int height, double amount, double radius)
{
  float *fimg[3]; // For original, high-pass, and low-pass images
  float *temp, amt;
  unsigned int i, lev, lpass, hpass, size, col, row;

  size = width * height;

  // Allocate memory for fimg arrays
  for (i = 0; i < 3; i++) {
	fimg[i] = (float *)malloc(size * sizeof(float));
	if (fimg[i] == NULL) {
	  // Handle memory allocation failure
	  // For simplicity, just return; in real code, you might want to free allocated memory
	  return;
	}
  }

  // Initialize fimg[0] with imageData
  for (i = 0; i < size; i++) {
	fimg[0][i] = imageData[i];
  }

  /* FIXME: replace by GIMP functions */
  temp = (float *) malloc (MAX2 (width, height) * sizeof (float));

  hpass = 0;
  for (lev = 0; lev < 5; lev++)
    {
      lpass = ((lev & 1) + 1);
      for (row = 0; row < height; row++)
	{
	  hat_transform (temp, fimg[hpass] + row * width, 1, width, 1 << lev);
	  for (col = 0; col < width; col++)
	    {
	      fimg[lpass][row * width + col] = temp[col] * 0.25;
	    }
	}
      for (col = 0; col < width; col++)
	{
	  hat_transform (temp, fimg[lpass] + col, width, height, 1 << lev);
	  for (row = 0; row < height; row++)
	    {
	      fimg[lpass][row * width + col] = temp[row] * 0.25;
	    }
	}
      amt = amount * exp (-(lev - radius) * (lev - radius) / 1.5) + 1;
      for (i = 0; i < size; i++)
	{
	  fimg[hpass][i] -= fimg[lpass][i];
	  fimg[hpass][i] *= amt;
	
	  if (hpass)
	    fimg[0][i] += fimg[hpass][i];
	}
      hpass = lpass;
    }

  for (i = 0; i < size; i++)
    fimg[0][i] = fimg[0][i] + fimg[lpass][i];

  // Copy the result back to imageData
  for (i = 0; i < size; i++) {
    imageData[i] = fimg[0][i];
  }

  // Free allocated memory
  for (i = 0; i < 3; i++) {
    free(fimg[i]);
  }
  
  free (temp);
}
